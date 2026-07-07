import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { validateImageField } from '@/lib/validators';

export async function GET() {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    // Branch-scoped users only see merchants belonging to their branch
    const where = user.branchId ? { branchId: user.branchId } : {};
    const merchants = await prisma.merchant.findMany({ where, orderBy: { createdAt: 'desc' } });
    return NextResponse.json(merchants);
  } catch (error) {
    console.error('Error fetching merchants:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !(user.permissions?.['merchants']?.create || user.permissions?.['branch']?.create)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { name, status, accountNumber, iconUrl, contactPersonName, contactPersonPhone, contactPersonEmail, additionalContactInfo, bnplEnabled } = body;
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (!accountNumber?.trim()) return NextResponse.json({ error: 'Account number is required' }, { status: 400 });
    if (!/^7\d{12}$/.test(accountNumber.trim())) return NextResponse.json({ error: 'Account number must start with 7 and be 13 characters long' }, { status: 400 });
    if (!contactPersonName?.trim()) return NextResponse.json({ error: 'Contact person name is required' }, { status: 400 });
    if (!contactPersonPhone?.trim()) return NextResponse.json({ error: 'Contact person phone is required' }, { status: 400 });
    if (!/^(09\d{8}|9\d{8}|\+2519\d{8})$/.test(contactPersonPhone.trim())) return NextResponse.json({ error: 'Invalid Ethiopian phone format' }, { status: 400 });
    if (contactPersonEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactPersonEmail.trim())) return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });

    // Validate icon image if provided
    const iconError = validateImageField(iconUrl, 'Icon');
    if (iconError) return NextResponse.json({ error: iconError }, { status: 400 });

    // Create as PendingChange for maker-checker
    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'Merchant',
        changeType: 'CREATE',
        payload: JSON.stringify({ created: {
          name: name.trim(),
          accountNumber: accountNumber?.trim() || null,
          iconUrl: iconUrl || null,
          contactPersonName: contactPersonName?.trim() || null,
          contactPersonPhone: contactPersonPhone?.trim() || null,
          contactPersonEmail: contactPersonEmail?.trim() || null,
          additionalContactInfo: additionalContactInfo?.trim() || null,
          bnplEnabled: bnplEnabled !== false,
          status: status || 'ACTIVE',
          branchId: user.branchId || null,
        } }),
        createdById: user.id,
      },
    });

    await createAuditLog({
      actorId: user.id,
      action: 'CREATE_MERCHANT_REQUEST',
      entity: 'Merchant',
      details: JSON.stringify({ name, accountNumber }),
    });

    return NextResponse.json(pending, { status: 201 });
  } catch (error) {
    console.error('Error creating merchant:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !(user.permissions?.['merchants']?.update || user.permissions?.['branch']?.update)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { id, name, status, accountNumber, iconUrl, contactPersonName, contactPersonPhone, contactPersonEmail, additionalContactInfo, bnplEnabled } = body;
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.merchant.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Merchant not found' }, { status: 404 });

    // Branch-scoped users can only update merchants that belong to their branch
    if (user.branchId && existing.branchId !== user.branchId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Validate updated fields
    const finalAccountNumber = accountNumber !== undefined ? accountNumber : existing.accountNumber;
    if (finalAccountNumber?.trim() && !/^7\d{12}$/.test(finalAccountNumber.trim())) return NextResponse.json({ error: 'Account number must start with 7 and be 13 characters long' }, { status: 400 });
    const finalContactPhone = contactPersonPhone !== undefined ? contactPersonPhone : existing.contactPersonPhone;
    if (finalContactPhone?.trim() && !/^(09\d{8}|9\d{8}|\+2519\d{8})$/.test(finalContactPhone.trim())) return NextResponse.json({ error: 'Invalid Ethiopian phone format' }, { status: 400 });
    const finalContactEmail = contactPersonEmail !== undefined ? contactPersonEmail : existing.contactPersonEmail;
    if (finalContactEmail?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finalContactEmail.trim())) return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });

    // Validate icon image if provided
    if (iconUrl !== undefined && iconUrl) {
      const iconError = validateImageField(iconUrl, 'Icon');
      if (iconError) return NextResponse.json({ error: iconError }, { status: 400 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'Merchant',
        entityId: id,
        changeType: 'UPDATE',
        payload: JSON.stringify({
          original: existing,
          updated: {
            name: name ?? existing.name,
            status: status ?? existing.status,
            accountNumber: accountNumber !== undefined ? (accountNumber?.trim() || null) : existing.accountNumber,
            iconUrl: iconUrl !== undefined ? (iconUrl || null) : existing.iconUrl,
            contactPersonName: contactPersonName !== undefined ? (contactPersonName?.trim() || null) : existing.contactPersonName,
            contactPersonPhone: contactPersonPhone !== undefined ? (contactPersonPhone?.trim() || null) : existing.contactPersonPhone,
            contactPersonEmail: contactPersonEmail !== undefined ? (contactPersonEmail?.trim() || null) : existing.contactPersonEmail,
            additionalContactInfo: additionalContactInfo !== undefined ? (additionalContactInfo?.trim() || null) : existing.additionalContactInfo,
            bnplEnabled: bnplEnabled !== undefined ? bnplEnabled : existing.bnplEnabled,
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({
      actorId: user.id,
      action: 'UPDATE_MERCHANT_REQUEST',
      entity: 'Merchant',
      entityId: id,
      details: JSON.stringify({ name, status, accountNumber }),
    });

    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error updating merchant:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !(user.permissions?.['merchants']?.delete || user.permissions?.['branch']?.delete)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.merchant.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Merchant not found' }, { status: 404 });

    // Branch-scoped users can only delete merchants that belong to their branch
    if (user.branchId && existing.branchId !== user.branchId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'Merchant',
        entityId: id,
        changeType: 'DELETE',
        payload: JSON.stringify({ original: existing }),
        createdById: user.id,
      },
    });

    await createAuditLog({
      actorId: user.id,
      action: 'DELETE_MERCHANT_REQUEST',
      entity: 'Merchant',
      entityId: id,
    });

    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error deleting merchant:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
