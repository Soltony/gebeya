

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { loginSchema, passwordSchema, phoneNumberSchema } from '@/lib/validators';
import { validationErrorResponse, handleApiError } from '@/lib/error-utils';
import { isBlocked, recordFailedAttempt, resetAttempts, getRemainingAttempts, getBackoffSeconds, getLockRemainingMs } from '@/lib/rate-limiter';
import { createAuditLog } from '@/lib/audit-log';
import { getUserFromSession } from '@/lib/user';
import { revokeAllUserSessions } from '@/lib/session';
import { sendSms } from '@/lib/sms';

const userSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  email: z.string().email('Invalid email address'),
  phoneNumber: phoneNumberSchema,
  // password is validated with the stronger shared login schema below
  password: z.string().optional(),
  role: z.string(), // Role name, will be connected by ID
  providerId: z.string().nullable().optional(),
  merchantId: z.string().nullable().optional(),
  status: z.enum(['Active', 'Inactive']),
});

export async function GET() {
    const user = await getUserFromSession();
    const hasAccessControl = !!user?.permissions?.['access-control']?.read;
    const hasBranchPerm = !!user?.permissions?.['branch']?.read;
    if (!user || !(hasAccessControl || hasBranchPerm)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

  try {
    // Horizontal access control: non-super-admins can only see users of their own provider or unassigned users
    const whereClause: any = {};
    if (user.branchId && !hasAccessControl) {
        // Branch users can only see merchant-role users tied to merchants of their branch
        const branchMerchants = await prisma.merchant.findMany({ where: { branchId: user.branchId }, select: { id: true } });
        const merchantIds = branchMerchants.map(m => m.id);
        whereClause.merchantId = { in: merchantIds };
    } else if (user.role !== 'Super Admin' && user.loanProviderId) {
        whereClause.OR = [
            { loanProviderId: user.loanProviderId },
            { loanProviderId: null }
        ];
    }


    const users = await prisma.user.findMany({
      where: whereClause,
      include: {
        role: true,
        loanProvider: true,
        merchant: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const formattedUsers = users.map(user => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: user.role.name,
      providerName: user.loanProvider?.name || 'N/A',
      providerId: user.loanProvider?.id,
      merchantId: user.merchantId,
      merchantName: user.merchant?.name || null,
      status: user.status,
    }));

    return NextResponse.json(formattedUsers);
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
    const user = await getUserFromSession();
    if (!user || !(user.permissions?.['access-control']?.create || user.permissions?.['branch']?.create)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const ipAddress = req.ip || req.headers.get('x-forwarded-for') || 'N/A';
    const userAgent = req.headers.get('user-agent') || 'N/A';
    const ipAddressKey = req.ip || req.headers.get('x-forwarded-for') || 'unknown-ip';
    const rateKey = `createUser:${user.id}:${ipAddressKey}`;

    // Quick rate-limit check to avoid heavy processing when the caller is blocked
    if (isBlocked(rateKey)) {
      const lockMs = getLockRemainingMs(rateKey);
      const retryAfterSeconds = Math.ceil(lockMs / 1000) || 1;
      return NextResponse.json({ error: 'Too many attempts. Try again later.', retryAfter: retryAfterSeconds }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } });
    }
  try {

    const body = await req.json();
    const { password, role: roleName, providerId, merchantId, ...userData } = userSchema.parse(body);
    // Validate password with the stronger shared password rules (includes breach check)
    try {
      // Use the exported `passwordSchema` which includes the async HaveIBeenPwned check.
      // Wrap into an object so we can pass the same shape as before.
      const pwWrapper = z.object({ password: passwordSchema });
      await pwWrapper.parseAsync({ password });
    } catch (err) {
      if (err instanceof ZodError) {
        // record failed attempt and apply the same lockout/backoff behavior as login
        recordFailedAttempt(rateKey);
        if (isBlocked(rateKey)) {
          const lockMs = getLockRemainingMs(rateKey);
          const retryAfterSeconds = Math.ceil(lockMs / 1000) || 1;
          return NextResponse.json({ error: 'Too many attempts. Try again later.', retryAfter: retryAfterSeconds }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } });
        }
        const backoff = getBackoffSeconds(rateKey);
        if (backoff > 0) await new Promise((res) => setTimeout(res, backoff * 1000));
        const remaining = getRemainingAttempts(rateKey);
        // Return sanitized validation issues
        return NextResponse.json({ error: 'Invalid password.', retriesLeft: remaining, delaySeconds: backoff, issues: err.errors }, { status: 400 });
      }
      // Unexpected error: log & return generic message
      return handleApiError(err, { operation: 'POST /api/users' });
    }

    const logDetails = { userEmail: userData.email, assignedRole: roleName };
    await createAuditLog({ actorId: user.id, action: 'USER_CREATE_INITIATED', entity: 'USER', details: logDetails, ipAddress, userAgent });

    if (!password) {
      throw new Error('Password is required for new users.');
    }

    const role = await prisma.role.findUnique({ where: { name: roleName }});
    if (!role) {
      throw new Error('Invalid role selected.');
    }

    // Vertical Escalation Prevention
    if (user.role !== 'Super Admin' && (role.name === 'Super Admin' || role.name === 'Admin')) {
        return NextResponse.json({ error: 'You cannot create a user with a higher-privileged role.' }, { status: 403 });
    }
    // Horizontal Escalation Prevention
    if (user.role !== 'Super Admin' && providerId && providerId !== user.loanProviderId) {
        return NextResponse.json({ error: 'You can only create users for your own provider.' }, { status: 403 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const dataToCreate: any = {
        ...userData,
        password: hashedPassword,
        passwordChangeRequired: true, // Force password change on first login
        roleId: role.id,
    };
    
    // Only assign providerId if the creator is allowed to and the role requires it
    if (user.role === 'Super Admin' || (user.loanProviderId && providerId === user.loanProviderId)) {
       if (providerId) {
            dataToCreate.loanProviderId = providerId;
        }
    }

    // Assign merchantId if provided (for merchant-role users)
    if (merchantId) {
      dataToCreate.merchantId = merchantId;
    }

    // Branch-scoped users: ensure the merchant belongs to their branch
    if (user.branchId && merchantId) {
      const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { branchId: true } });
      if (!merchant || merchant.branchId !== user.branchId) {
        return NextResponse.json({ error: 'You can only create users for merchants in your branch.' }, { status: 403 });
      }
    }


    const newUser = await prisma.user.create({
      data: dataToCreate,
    });
    
    // Successful creation: clear recorded failed attempts for this creator+ip
    try { resetAttempts(rateKey); } catch (e) { /* noop */ }

    const successLogDetails = { createdUserId: newUser.id, createdUserEmail: newUser.email, assignedRole: roleName };
    await createAuditLog({ actorId: user.id, action: 'USER_CREATE_SUCCESS', entity: 'USER', entityId: newUser.id, details: successLogDetails, ipAddress, userAgent });

    // Send SMS with login credentials for merchant-role users
    if (roleName === 'Merchant' && password && userData.phoneNumber) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.CALLBACK_URL?.replace(/\/api\/.*$/, '') || 'https://nibteraloan.nibbank.com.et';
      const smsText = `Welcome to NIB BNPL. Your merchant account has been created.\nLogin: ${appUrl}/admin/login\nEmail: ${userData.email}\nPassword: ${password}\nPlease change your password on first login.`;
      sendSms(userData.phoneNumber, smsText).catch((err: any) => {
        console.error('[merchant-user] SMS send failed:', err);
      });
    }


    // Never return password hashes (or other auth secrets) in API responses.
    const createdUser = await prisma.user.findUnique({
      where: { id: newUser.id },
      include: { role: true, loanProvider: true },
    });

    if (!createdUser) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    return NextResponse.json(
      {
        id: createdUser.id,
        fullName: createdUser.fullName,
        email: createdUser.email,
        phoneNumber: createdUser.phoneNumber,
        role: createdUser.role.name,
        providerName: createdUser.loanProvider?.name || 'N/A',
        providerId: createdUser.loanProvider?.id,
        status: createdUser.status,
        passwordChangeRequired: createdUser.passwordChangeRequired,
      },
      { status: 201 }
    );
  } catch (error) {
    const errorMessage = (error instanceof ZodError) ? error.errors : (error as Error).message;
     const failureLogDetails = { error: errorMessage };
     await createAuditLog({ actorId: user.id, action: 'USER_CREATE_FAILED', entity: 'USER', details: failureLogDetails, ipAddress, userAgent });
     console.error(JSON.stringify({ ...failureLogDetails, action: 'USER_CREATE_FAILED', actorId: user.id }));
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid request', issues: error.errors }, { status: 400 });
    }
    // Specific P2002 (unique constraint) error handling
    if ((error as any)?.code === 'P2002') {
      const target = (error as any).meta?.target;
      if (Array.isArray(target) && target.includes('email')) {
        return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 409 });
      }
      if (Array.isArray(target) && target.includes('phoneNumber')) {
        return NextResponse.json({ error: 'A user with this phone number already exists.' }, { status: 409 });
      }
      return NextResponse.json({ error: 'A user with these details already exists.' }, { status: 409 });
    }
    return handleApiError(error, { operation: 'POST /api/users' });
  }
}

export async function PUT(req: NextRequest) {
    const user = await getUserFromSession();
    if (!user || !(user.permissions?.['access-control']?.update || user.permissions?.['branch']?.update)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const ipAddress = req.ip || req.headers.get('x-forwarded-for') || 'N/A';
    const userAgent = req.headers.get('user-agent') || 'N/A';
  try {

    const body = await req.json();
    const { id, role: roleName, providerId, merchantId, password, ...userData } = body;

    if (!id) {
        throw new Error('User ID is required for an update.');
    }

    const existingUser = await prisma.user.findUnique({
      where: { id },
      select: { roleId: true, status: true },
    });
    if (!existingUser) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }
    
    // Horizontal access control: non-super-admins can only edit users in their own provider or unassigned users
    if (user.role !== 'Super Admin' && user.loanProviderId) {
        const userToEdit = await prisma.user.findUnique({ where: { id }});
        if (userToEdit && userToEdit.loanProviderId && userToEdit.loanProviderId !== user.loanProviderId) {
            return NextResponse.json({ error: 'You do not have permission to edit this user.' }, { status: 403 });
        }
    }


    const logDetails = { updatedUserId: id, updatedFields: Object.keys(userData) };
    await createAuditLog({ actorId: user.id, action: 'USER_UPDATE_INITIATED', entity: 'USER', entityId: id, details: logDetails, ipAddress, userAgent });

    let dataToUpdate: any = { ...userData };

    const passwordWasReset = !!password;
    let roleChanged = false;
    const statusChanged = typeof userData?.status === 'string' && userData.status !== existingUser.status;

    if (roleName) {
        const role = await prisma.role.findUnique({ where: { name: roleName }});
        if (!role) {
            throw new Error('Invalid role selected.');
        }
        
        // Vertical Escalation Prevention
        if (user.role !== 'Super Admin' && (role.name === 'Super Admin' || role.name === 'Admin')) {
            return NextResponse.json({ error: 'You cannot assign a higher-privileged role.' }, { status: 403 });
        }

    dataToUpdate.roleId = role.id;
    roleChanged = role.id !== existingUser.roleId;
    }
    
    if (password) {
      try {
        const pwWrapper = z.object({ password: passwordSchema });
        await pwWrapper.parseAsync({ password });
      } catch (err) {
        if (err instanceof ZodError) {
          return NextResponse.json({ error: 'Invalid password', issues: err.errors }, { status: 400 });
        }
        throw err;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      dataToUpdate.password = hashedPassword;
      dataToUpdate.passwordChangeRequired = true; // Force user to change password on next login
    }

    // Handle providerId relationship
    if (user.role === 'Super Admin') {
        if (providerId === null) {
            dataToUpdate.loanProviderId = null;
        } else if (providerId) {
            dataToUpdate.loanProviderId = providerId;
        }
    } else if (user.loanProviderId) {
        // Non-super-admins can only assign users to their own provider
        if (providerId && providerId !== user.loanProviderId) {
             return NextResponse.json({ error: 'You can only assign users to your own provider.' }, { status: 403 });
        }
        dataToUpdate.loanProviderId = providerId;
    }

    // Handle merchantId relationship
    if (merchantId !== undefined) {
      dataToUpdate.merchantId = merchantId || null;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: dataToUpdate,
    });

    // Privilege/session lifecycle control:
    // - role changes => revoke sessions (permissions may change)
    // - account deactivation => revoke sessions
    // - password reset / forced password change => revoke sessions
    if (roleChanged || statusChanged || passwordWasReset || dataToUpdate.passwordChangeRequired === true) {
      try {
        await revokeAllUserSessions(id);
      } catch (e) {
        console.error('Failed to revoke user sessions after privilege change:', e);
      }
    }
    
    const successLogDetails = { updatedUserId: id, updatedFields: Object.keys(dataToUpdate) };
    await createAuditLog({ actorId: user.id, action: 'USER_UPDATE_SUCCESS', entity: 'USER', entityId: id, details: successLogDetails, ipAddress, userAgent });

    // Never return password hashes (or other auth secrets) in API responses.
    const updatedUserFull = await prisma.user.findUnique({
      where: { id: updatedUser.id },
      include: { role: true, loanProvider: true },
    });

    if (!updatedUserFull) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    return NextResponse.json({
      id: updatedUserFull.id,
      fullName: updatedUserFull.fullName,
      email: updatedUserFull.email,
      phoneNumber: updatedUserFull.phoneNumber,
      role: updatedUserFull.role.name,
      providerName: updatedUserFull.loanProvider?.name || 'N/A',
      providerId: updatedUserFull.loanProvider?.id,
      status: updatedUserFull.status,
      passwordChangeRequired: updatedUserFull.passwordChangeRequired,
    });
  } catch (error) {
    const errorMessage = (error as Error).message;
    const failureLogDetails = { error: errorMessage };
    await createAuditLog({ actorId: user.id, action: 'USER_UPDATE_FAILED', entity: 'USER', details: failureLogDetails, ipAddress, userAgent });
    console.error(JSON.stringify({ ...failureLogDetails, action: 'USER_UPDATE_FAILED', actorId: user.id }));
    return handleApiError(error, { operation: 'PUT /api/users', info: { userId: body?.id } });
  }
}

// ── PATCH: Resend SMS or Reset Password ────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !(user.permissions?.['access-control']?.update || user.permissions?.['branch']?.update)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const ipAddress = req.ip || req.headers.get('x-forwarded-for') || 'N/A';
  const userAgent = req.headers.get('user-agent') || 'N/A';

  try {
    const { id, action } = await req.json();
    if (!id || !action) {
      return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Horizontal access control
    if (user.role !== 'Super Admin' && user.loanProviderId) {
      if (targetUser.loanProviderId && targetUser.loanProviderId !== user.loanProviderId) {
        return NextResponse.json({ error: 'You do not have permission to manage this user.' }, { status: 403 });
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.CALLBACK_URL?.replace(/\/api\/.*$/, '') || 'https://nibteraloan.nibbank.com.et';

    if (action === 'resend-sms') {
      if (!targetUser.phoneNumber) {
        return NextResponse.json({ error: 'User has no phone number' }, { status: 400 });
      }

      const smsText = `NIB BNPL: Your account credentials.\nLogin: ${appUrl}/admin/login\nEmail: ${targetUser.email}\nPlease use your existing password or contact admin if you forgot it.`;
      await sendSms(targetUser.phoneNumber, smsText);

      await createAuditLog({
        actorId: user.id,
        action: 'USER_SMS_RESENT',
        entity: 'USER',
        entityId: targetUser.id,
        details: { targetEmail: targetUser.email },
        ipAddress,
        userAgent,
      });

      return NextResponse.json({ message: 'SMS sent successfully' });
    }

    if (action === 'reset-password') {
      const newPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).toUpperCase().slice(2) + '!1';
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      await prisma.user.update({
        where: { id },
        data: { password: hashedPassword, passwordChangeRequired: true },
      });

      // Revoke existing sessions
      try { await revokeAllUserSessions(id); } catch { /* ignore */ }

      if (targetUser.phoneNumber) {
        const smsText = `NIB BNPL: Your password has been reset.\nLogin: ${appUrl}/admin/login\nEmail: ${targetUser.email}\nNew Password: ${newPassword}\nPlease change your password on first login.`;
        await sendSms(targetUser.phoneNumber, smsText);
      }

      await createAuditLog({
        actorId: user.id,
        action: 'USER_PASSWORD_RESET',
        entity: 'USER',
        entityId: targetUser.id,
        details: { targetEmail: targetUser.email },
        ipAddress,
        userAgent,
      });

      return NextResponse.json({ message: 'Password reset and SMS sent' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    return handleApiError(error, { operation: 'PATCH /api/users' });
  }
}

export async function DELETE(req: NextRequest) {
    const user = await getUserFromSession();
    if (!user || !(user.permissions?.['access-control']?.delete || user.permissions?.['branch']?.delete)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const ipAddress = req.ip || req.headers.get('x-forwarded-for') || 'N/A';
    const userAgent = req.headers.get('user-agent') || 'N/A';
    try {
        const body = await req.json();
        const { id } = body;
        if (!id) return NextResponse.json({ error: 'User ID is required' }, { status: 400 });

        const existingUser = await prisma.user.findUnique({ where: { id }, include: { role: true } });
        if (!existingUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

        // Prevent deleting Super Admin users by non-super-admins
        if (existingUser.role.name === 'Super Admin' && user.role !== 'Super Admin') {
            return NextResponse.json({ error: 'You cannot delete a Super Admin user.' }, { status: 403 });
        }

        // Horizontal access control
        if (user.role !== 'Super Admin' && user.loanProviderId) {
            if (existingUser.loanProviderId && existingUser.loanProviderId !== user.loanProviderId) {
                return NextResponse.json({ error: 'You do not have permission to delete this user.' }, { status: 403 });
            }
        }

        // Revoke sessions before deleting
        try { await revokeAllUserSessions(id); } catch { /* ignore */ }

        await prisma.user.delete({ where: { id } });

        await createAuditLog({
            actorId: user.id,
            action: 'USER_DELETE_SUCCESS',
            entity: 'USER',
            entityId: id,
            details: JSON.stringify({ deletedUserEmail: existingUser.email }),
            ipAddress,
            userAgent,
        });

        return NextResponse.json({ message: 'User deleted successfully' });
    } catch (error) {
        const errorMessage = (error as Error).message;
        await createAuditLog({ actorId: user.id, action: 'USER_DELETE_FAILED', entity: 'USER', details: { error: errorMessage }, ipAddress, userAgent });
        console.error('Error deleting user:', error);
        return handleApiError(error, { operation: 'DELETE /api/users' });
    }
}
