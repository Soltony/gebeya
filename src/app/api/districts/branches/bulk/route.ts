import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import ExcelJS from 'exceljs';

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['branch']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const districtId = formData.get('districtId') as string | null;

    if (!file) return NextResponse.json({ error: 'File is required' }, { status: 400 });
    if (!districtId) return NextResponse.json({ error: 'District is required' }, { status: 400 });

    const district = await prisma.district.findUnique({ where: { id: districtId } });
    if (!district) return NextResponse.json({ error: 'District not found' }, { status: 404 });

    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(Buffer.from(arrayBuffer) as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) return NextResponse.json({ error: 'No worksheet found in file' }, { status: 400 });

    const branches: { name: string; status: string }[] = [];
    const parseErrors: string[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header row
      const nameCell = row.getCell(1).value;
      const statusCell = row.getCell(2).value;

      const name = nameCell?.toString()?.trim();
      const rawStatus = statusCell?.toString()?.trim()?.toUpperCase();
      const status = rawStatus && ['ACTIVE', 'INACTIVE'].includes(rawStatus) ? rawStatus : 'ACTIVE';

      if (!name) {
        parseErrors.push(`Row ${rowNumber}: Branch name is required`);
        return;
      }
      branches.push({ name, status });
    });

    if (parseErrors.length > 0) {
      return NextResponse.json({ error: 'Validation errors in file', errors: parseErrors }, { status: 400 });
    }
    if (branches.length === 0) {
      return NextResponse.json({ error: 'No valid branch rows found in file (ensure data starts from row 2)' }, { status: 400 });
    }

    const created: string[] = [];
    const skipped: string[] = [];

    for (const b of branches) {
      try {
        const branch = await prisma.branch.create({
          data: { name: b.name, districtId, status: b.status },
        });
        created.push(branch.name);
      } catch (e: any) {
        if (e.code === 'P2002') {
          skipped.push(b.name);
        } else {
          throw e;
        }
      }
    }

    await createAuditLog({
      actorId: user.id,
      action: 'BULK_CREATE_BRANCHES',
      entity: 'Branch',
      details: JSON.stringify({ districtId, districtName: district.name, created: created.length, skipped: skipped.length }),
    });

    return NextResponse.json({ created: created.length, skipped, total: branches.length });
  } catch (error) {
    console.error('Error bulk uploading branches:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
