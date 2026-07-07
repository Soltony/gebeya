import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.read) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const districtId = searchParams.get('districtId');

    const branches = await prisma.branch.findMany({
      where: districtId ? { districtId } : undefined,
      include: { district: true, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json(branches);
  } catch (error) {
    console.error('Error fetching branches:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { name, districtId, status } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (!districtId) return NextResponse.json({ error: 'District is required' }, { status: 400 });

    const branch = await prisma.branch.create({
      data: { name: name.trim(), districtId, status: status || 'ACTIVE' },
      include: { district: true, _count: { select: { users: true } } },
    });
    await createAuditLog({
      actorId: user.id,
      action: 'CREATE_BRANCH',
      entity: 'Branch',
      entityId: branch.id,
      details: JSON.stringify({ name, districtId }),
    });
    return NextResponse.json(branch, { status: 201 });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'A branch with this name already exists in this district' }, { status: 409 });
    }
    console.error('Error creating branch:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { id, name, districtId, status } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    const updated = await prisma.branch.update({
      where: { id },
      data: {
        name: name.trim(),
        ...(districtId && { districtId }),
        ...(status && { status }),
      },
      include: { district: true, _count: { select: { users: true } } },
    });
    await createAuditLog({ actorId: user.id, action: 'UPDATE_BRANCH', entity: 'Branch', entityId: id });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'A branch with this name already exists in this district' }, { status: 409 });
    }
    console.error('Error updating branch:', error);
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

    await prisma.branch.delete({ where: { id } });
    await createAuditLog({ actorId: user.id, action: 'DELETE_BRANCH', entity: 'Branch', entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting branch:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
