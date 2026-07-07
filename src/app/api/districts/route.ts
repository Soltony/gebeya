import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';

export async function GET() {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.read) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const districts = await prisma.district.findMany({
      include: { _count: { select: { branches: true } } },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json(districts);
  } catch (error) {
    console.error('Error fetching districts:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { name, status } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    const district = await prisma.district.create({
      data: { name: name.trim(), status: status || 'ACTIVE' },
      include: { _count: { select: { branches: true } } },
    });
    await createAuditLog({
      actorId: user.id,
      action: 'CREATE_DISTRICT',
      entity: 'District',
      entityId: district.id,
      details: JSON.stringify({ name }),
    });
    return NextResponse.json(district, { status: 201 });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'A district with this name already exists' }, { status: 409 });
    }
    console.error('Error creating district:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const { id, name, status } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    const updated = await prisma.district.update({
      where: { id },
      data: { name: name.trim(), ...(status && { status }) },
      include: { _count: { select: { branches: true } } },
    });
    await createAuditLog({ actorId: user.id, action: 'UPDATE_DISTRICT', entity: 'District', entityId: id });
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'A district with this name already exists' }, { status: 409 });
    }
    console.error('Error updating district:', error);
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

    await prisma.district.delete({ where: { id } });
    await createAuditLog({ actorId: user.id, action: 'DELETE_DISTRICT', entity: 'District', entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting district:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
