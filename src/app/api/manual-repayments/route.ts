/**
 * GET  /api/manual-repayments  — the manual repayment, pending-approval and
 *                                rejected/reversed reports.
 * POST /api/manual-repayments  — a Maker records a repayment.
 *
 * A POST only ever creates a PENDING_APPROVAL row. Nothing reaches the loan until
 * a Checker approves it in `[id]/decision`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { getAsOfDate, parseDayEnd, parseDayStart } from '@/lib/date-utils';
import { handleApiError, validationErrorResponse } from '@/lib/error-utils';
import {
  ALLOWED_ATTACHMENT_TYPES,
  LIVE_STATUSES,
  MANUAL_REPAYMENT_STATUSES,
  MAX_ATTACHMENT_BYTES,
  PAYMENT_SOURCES,
  activeReferenceKey,
  getManualRepaymentPolicy,
  loanBalanceSnapshot,
  normalizeReference,
  validateRepaymentEntry,
} from '@/lib/manual-repayment';
import {
  MANUAL_REPAYMENT_INCLUDE,
  emptyStatusSummary,
  serializeManualRepayment,
} from '@/lib/manual-repayment-serialize';
import {
  canEnterRepayment,
  canViewRepayments,
  requestActorContext,
} from '@/lib/manual-repayment-access';

const DEFAULT_PAGE_SIZE = 20;

const entrySchema = z.object({
  loanId: z.string().min(1),
  amount: z.number().positive(),
  paymentSource: z.enum(PAYMENT_SOURCES),
  referenceNumber: z.string().min(1).max(100),
  paymentDate: z.string().min(1),
  remarks: z.string().max(2000).optional().nullable(),
  attachment: z
    .object({
      name: z.string().min(1).max(255),
      type: z.enum(ALLOWED_ATTACHMENT_TYPES),
      size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
      data: z.string().min(1),
    })
    .optional()
    .nullable(),
});

// --------------------------------------
// Reports / listing
// --------------------------------------

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !canViewRepayments(user)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(
    500,
    Math.max(1, parseInt(params.get('limit') || String(DEFAULT_PAGE_SIZE), 10)),
  );
  const statuses = (params.get('status') || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => (MANUAL_REPAYMENT_STATUSES as readonly string[]).includes(s));
  const source = params.get('paymentSource')?.trim().toUpperCase();
  const makerId = params.get('makerId')?.trim();
  const search = params.get('search')?.trim();
  const from = parseDayStart(params.get('from'));
  const to = parseDayEnd(params.get('to'));

  try {
    const where: Prisma.ManualRepaymentWhereInput = {};
    if (statuses.length) where.status = { in: statuses };
    if (source && (PAYMENT_SOURCES as readonly string[]).includes(source)) {
      where.paymentSource = source;
    }
    if (makerId) where.makerId = makerId;
    if (from || to) {
      where.paymentDate = {};
      if (from) where.paymentDate.gte = from;
      if (to) where.paymentDate.lte = to;
    }
    if (search) {
      where.OR = [
        { referenceNumber: { contains: search } },
        { loanId: { contains: search } },
        { borrowerId: { contains: search } },
      ];
    }

    const [total, rows, grouped] = await Promise.all([
      prisma.manualRepayment.count({ where }),
      prisma.manualRepayment.findMany({
        where,
        include: MANUAL_REPAYMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.manualRepayment.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const summary = emptyStatusSummary();
    for (const g of grouped) {
      summary[g.status] = { count: g._count._all, amount: g._sum.amount ?? 0 };
    }

    return NextResponse.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      rows: rows.map(serializeManualRepayment),
      summary,
    });
  } catch (error) {
    return handleApiError(error, { operation: 'GET /api/manual-repayments' });
  }
}

// --------------------------------------
// Entry
// --------------------------------------

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !canEnterRepayment(user)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const { ipAddress, userAgent } = requestActorContext(req);

  try {
    const body = entrySchema.parse(await req.json());
    const referenceNumber = normalizeReference(body.referenceNumber);
    const paymentDate = new Date(body.paymentDate);

    const [loan, taxConfigs, policy] = await Promise.all([
      prisma.loan.findUnique({
        where: { id: body.loanId },
        include: {
          product: true,
          installments: { orderBy: { installmentNumber: 'asc' } },
          payments: { orderBy: { date: 'asc' } },
        },
      }),
      prisma.tax.findMany({ where: { status: 'ACTIVE' } }),
      getManualRepaymentPolicy(prisma),
    ]);

    if (!loan) {
      return NextResponse.json({ error: 'Loan not found.' }, { status: 404 });
    }

    const today = getAsOfDate();
    const balance = loanBalanceSnapshot(
      loan as never,
      loan.product,
      taxConfigs,
      loan.installments as never,
      today,
    );

    const { errors, warnings } = validateRepaymentEntry(
      {
        amount: body.amount,
        paymentSource: body.paymentSource,
        referenceNumber,
        paymentDate,
        hasAttachment: !!body.attachment,
      },
      {
        policy,
        payableNow: balance.payableNow,
        loanRepaymentStatus: loan.repaymentStatus,
        loanDisbursedDate: loan.disbursedDate,
        today: endOfDayOf(today),
      },
    );
    if (errors.length) {
      return NextResponse.json({ error: errors[0], errors, warnings }, { status: 400 });
    }

    // Duplicate payment: the same amount, on the same day, through the same source,
    // against the same loan — a re-submitted form rather than a second repayment.
    const duplicate = await prisma.manualRepayment.findFirst({
      where: {
        loanId: loan.id,
        amount: body.amount,
        paymentSource: body.paymentSource,
        status: { in: LIVE_STATUSES },
        paymentDate: { gte: startOfDayOf(paymentDate), lte: endOfDayOf(paymentDate) },
      },
      select: { id: true, referenceNumber: true, status: true },
    });
    if (duplicate) {
      return NextResponse.json(
        {
          error:
            `An identical repayment (${duplicate.referenceNumber}) is already recorded for this loan ` +
            `on this date and is ${duplicate.status.replace(/_/g, ' ').toLowerCase()}.`,
          duplicateId: duplicate.id,
        },
        { status: 409 },
      );
    }

    const created = await prisma.manualRepayment.create({
      data: {
        loanId: loan.id,
        borrowerId: loan.borrowerId,
        amount: body.amount,
        paymentSource: body.paymentSource,
        referenceNumber,
        referenceKey: activeReferenceKey(body.paymentSource, referenceNumber),
        paymentDate,
        remarks: body.remarks?.trim() || null,
        attachmentName: body.attachment?.name ?? null,
        attachmentType: body.attachment?.type ?? null,
        attachmentSize: body.attachment?.size ?? null,
        attachmentData: body.attachment?.data ?? null,
        status: 'PENDING_APPROVAL',
        balanceBefore: balance.total,
        principalBefore: balance.principal,
        interestBefore: balance.interest,
        serviceFeeBefore: balance.serviceFee,
        penaltyBefore: balance.penalty,
        taxBefore: balance.tax,
        loanStatusBefore: loan.repaymentStatus,
        installmentNumber: balance.installmentNumber,
        makerId: user.id,
        makerIp: ipAddress,
        makerUserAgent: userAgent,
      },
      select: { id: true, referenceNumber: true, amount: true, status: true },
    });

    await createAuditLog({
      actorId: user.id,
      action: 'MANUAL_REPAYMENT_SUBMITTED',
      entity: 'ManualRepayment',
      entityId: created.id,
      ipAddress,
      userAgent,
      details: {
        loanId: loan.id,
        borrowerId: loan.borrowerId,
        amount: body.amount,
        paymentSource: body.paymentSource,
        referenceNumber,
        paymentDate: paymentDate.toISOString(),
        balanceBefore: balance,
        makerName: user.fullName,
      },
    });

    return NextResponse.json({ ok: true, repayment: created, warnings }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'This reference number has already been used for this payment source.' },
        { status: 409 },
      );
    }
    return handleApiError(error, { operation: 'POST /api/manual-repayments' });
  }
}

const startOfDayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDayOf = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
