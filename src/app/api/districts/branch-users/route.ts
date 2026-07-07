import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { sendSms } from '@/lib/sms';

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.read) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const branchId = searchParams.get('branchId');

    const users = await prisma.user.findMany({
      where: {
        branchId: branchId ? branchId : { not: null },
      },
      include: {
        role: true,
        branch: { include: { district: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(
      users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phoneNumber: u.phoneNumber,
        role: u.role.name,
        status: u.status,
        branchId: u.branchId,
        branchName: u.branch?.name ?? null,
        districtName: u.branch?.district?.name ?? null,
      }))
    );
  } catch (error) {
    console.error('Error fetching branch users:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { fullName, email, phoneNumber, password, role: roleName, branchId, status } = await req.json();

    if (!fullName?.trim() || !email?.trim() || !phoneNumber?.trim()) {
      return NextResponse.json({ error: 'Full name, email, and phone are required' }, { status: 400 });
    }
    if (!branchId) {
      return NextResponse.json({ error: 'Branch assignment is required' }, { status: 400 });
    }

    const role = await prisma.role.findUnique({ where: { name: roleName || 'Branch' } });
    if (!role) {
      return NextResponse.json({ error: `Role "${roleName || 'Branch'}" not found` }, { status: 400 });
    }

    // Vertical escalation prevention
    if (user.role !== 'Super Admin' && (role.name === 'Super Admin' || role.name === 'Admin')) {
      return NextResponse.json({ error: 'You cannot assign a higher-privileged role' }, { status: 403 });
    }

    const rawPassword =
      password?.trim() ||
      Math.random().toString(36).slice(2) + Math.random().toString(36).toUpperCase().slice(2) + '!1';
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const newUser = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phoneNumber: phoneNumber.trim(),
        password: hashedPassword,
        passwordChangeRequired: true,
        status: status || 'Active',
        roleId: role.id,
        branchId,
      },
      include: { role: true, branch: { include: { district: true } } },
    });

    await createAuditLog({
      actorId: user.id,
      action: 'CREATE_BRANCH_USER',
      entity: 'User',
      entityId: newUser.id,
      details: JSON.stringify({ email, branchId }),
    });

    // Send SMS with login credentials
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.CALLBACK_URL?.replace(/\/api\/.*$/, '') || 'https://nibteraloan.nibbank.com.et';
    const smsText = `Welcome to NIB BNPL. Your account has been created.\nLogin: ${appUrl}/admin/login\nEmail: ${email.trim().toLowerCase()}\nPassword: ${rawPassword}\nPlease change your password on first login.`;
    sendSms(phoneNumber.trim(), smsText).catch((err: any) => {
      console.error('[branch-user] SMS send failed:', err);
    });

    return NextResponse.json(
      {
        id: newUser.id,
        fullName: newUser.fullName,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
        role: newUser.role.name,
        status: newUser.status,
        branchId: newUser.branchId,
        branchName: newUser.branch?.name ?? null,
        districtName: newUser.branch?.district?.name ?? null,
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      if (Array.isArray(target) && target.includes('email') || String(target).includes('email')) {
        return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 409 });
      }
      if (Array.isArray(target) && target.includes('phoneNumber') || String(target).includes('phoneNumber')) {
        return NextResponse.json({ error: 'A user with this phone number already exists.' }, { status: 409 });
      }
      return NextResponse.json({ error: 'A user with this email or phone number already exists.' }, { status: 409 });
    }
    console.error('Error creating branch user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { id, branchId, fullName, email, phoneNumber, status } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(fullName?.trim() && { fullName: fullName.trim() }),
        ...(email?.trim() && { email: email.trim().toLowerCase() }),
        ...(phoneNumber?.trim() && { phoneNumber: phoneNumber.trim() }),
        ...(status && { status }),
        ...(branchId !== undefined && { branchId: branchId || null }),
      },
      include: { role: true, branch: { include: { district: true } } },
    });

    await createAuditLog({ actorId: user.id, action: 'UPDATE_BRANCH_USER', entity: 'User', entityId: id });

    return NextResponse.json({
      id: updated.id,
      fullName: updated.fullName,
      email: updated.email,
      phoneNumber: updated.phoneNumber,
      role: updated.role.name,
      status: updated.status,
      branchId: updated.branchId,
      branchName: updated.branch?.name ?? null,
      districtName: updated.branch?.district?.name ?? null,
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      if (Array.isArray(target) && target.includes('email') || String(target).includes('email')) {
        return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 409 });
      }
      if (Array.isArray(target) && target.includes('phoneNumber') || String(target).includes('phoneNumber')) {
        return NextResponse.json({ error: 'A user with this phone number already exists.' }, { status: 409 });
      }
      return NextResponse.json({ error: 'A user with this email or phone number already exists.' }, { status: 409 });
    }
    console.error('Error updating branch user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.delete) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    await prisma.user.delete({ where: { id } });
    await createAuditLog({ actorId: user.id, action: 'DELETE_BRANCH_USER', entity: 'User', entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting branch user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * PATCH — Resend SMS or Reset Password for a branch user
 * Body: { id: string; action: 'resend-sms' | 'reset-password' }
 */
export async function PATCH(req: NextRequest) {
  const currentUser = await getUserFromSession();
  if (!currentUser || !currentUser.permissions?.['branch']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { id, action } = await req.json();
    if (!id || !action) {
      return NextResponse.json({ error: 'id and action are required' }, { status: 400 });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: { id: true, fullName: true, email: true, phoneNumber: true, branchId: true },
    });
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (action === 'reset-password') {
      const newPassword =
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).toUpperCase().slice(2) +
        '!1';
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      await prisma.user.update({
        where: { id },
        data: { password: hashedPassword, passwordChangeRequired: true },
      });

      // Send SMS with new credentials
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.CALLBACK_URL?.replace(/\/api\/.*$/, '') ||
        'https://nibteraloan.nibbank.com.et';
      const smsText = `Your NIB BNPL password has been reset.\nLogin: ${appUrl}/admin/login\nEmail: ${targetUser.email}\nNew Password: ${newPassword}\nPlease change your password on first login.`;
      sendSms(targetUser.phoneNumber, smsText).catch((err: any) => {
        console.error('[branch-user] Reset password SMS failed:', err);
      });

      await createAuditLog({
        actorId: currentUser.id,
        action: 'RESET_BRANCH_USER_PASSWORD',
        entity: 'User',
        entityId: id,
      });

      return NextResponse.json({ success: true, message: 'Password reset. New credentials sent via SMS.' });
    }

    if (action === 'resend-sms') {
      // Generate a new password and resend
      const newPassword =
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).toUpperCase().slice(2) +
        '!1';
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      await prisma.user.update({
        where: { id },
        data: { password: hashedPassword, passwordChangeRequired: true },
      });

      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.CALLBACK_URL?.replace(/\/api\/.*$/, '') ||
        'https://nibteraloan.nibbank.com.et';
      const smsText = `Welcome to NIB BNPL. Your account has been created.\nLogin: ${appUrl}/admin/login\nEmail: ${targetUser.email}\nPassword: ${newPassword}\nPlease change your password on first login.`;
      sendSms(targetUser.phoneNumber, smsText).catch((err: any) => {
        console.error('[branch-user] Resend SMS failed:', err);
      });

      await createAuditLog({
        actorId: currentUser.id,
        action: 'RESEND_BRANCH_USER_SMS',
        entity: 'User',
        entityId: id,
      });

      return NextResponse.json({ success: true, message: 'SMS resent with new credentials.' });
    }

    return NextResponse.json({ error: 'Invalid action. Use "resend-sms" or "reset-password".' }, { status: 400 });
  } catch (error) {
    console.error('Error in branch user PATCH:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
