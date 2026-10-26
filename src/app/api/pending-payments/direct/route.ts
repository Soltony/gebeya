import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getUserFromSession } from "@/lib/user";
import { orderRef } from "@/lib/marketplace/order-status";
import { directPaymentFilter } from "@/lib/direct-payment-status";
import { telegramNamesByBorrower } from "@/lib/direct-payment-rows";

/**
 * GET /api/pending-payments/direct
 *
 * Order payments (DirectPendingPayment: NIB USSD push and super-app gateway)
 * for the Pending Payments page, so operators can settle the ones the bank
 * never confirmed. `status` is a filter key: OPEN (default), PROCESSING,
 * FAILED or COMPLETED. Supports pagination, from/to and a search over the
 * reference, order, customer phone, merchant and FT.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (
    !user ||
    (!user.permissions?.["pending-payments"]?.read &&
      !user.permissions?.["approvals"]?.read &&
      !user.permissions?.["reversals"]?.read)
  ) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const search = url.searchParams.get("search")?.trim();
  const filter = directPaymentFilter(url.searchParams.get("status"));

  const where: Prisma.DirectPendingPaymentWhereInput = { status: { in: [...filter.statuses] } };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.createdAt.lte = toDate;
    }
  }
  if (search) {
    where.OR = [
      { transactionId: { contains: search } },
      { orderId: { contains: search.replace(/^#/, "").toLowerCase() } },
      { borrowerId: { contains: search } },
      { merchant: { name: { contains: search } } },
      { ft: { cbsReference: { contains: search } } },
    ];
  }

  const [total, payments] = await Promise.all([
    prisma.directPendingPayment.count({ where }),
    prisma.directPendingPayment.findMany({
      where,
      // Never the attempt's keys.
      select: {
        id: true,
        transactionId: true,
        method: true,
        status: true,
        statusDesc: true,
        amount: true,
        borrowerId: true,
        customerPhone: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        statusCheckedAt: true,
        order: { select: { id: true, status: true, channel: true } },
        merchant: { select: { name: true, accountNumber: true } },
        ft: { select: { cbsReference: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const ids = payments.map((p) => p.id);
  const [approvals, names] = await Promise.all([
    ids.length
      ? prisma.pendingChange.findMany({
          where: { status: "PENDING", entityType: "DirectPaymentResolve", entityId: { in: ids } },
          select: { entityId: true, id: true, createdAt: true },
        })
      : [],
    telegramNamesByBorrower(payments.map((p) => p.borrowerId)),
  ]);
  const approvalMap = new Map(approvals.map((a) => [a.entityId, a]));

  const rows = payments.map((p) => {
    const approval = approvalMap.get(p.id);
    return {
      id: p.id,
      transactionId: p.transactionId,
      method: p.method,
      status: p.status,
      statusDesc: p.statusDesc,
      amount: p.amount,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
      statusCheckedAt: p.statusCheckedAt?.toISOString() ?? null,
      order: { id: p.order.id, ref: orderRef(p.order.id), status: p.order.status, channel: p.order.channel },
      customer: { phone: p.customerPhone || p.borrowerId, name: names.get(p.borrowerId) ?? null },
      merchant: { name: p.merchant.name, accountNumber: p.merchant.accountNumber },
      cbsReference: p.ft?.cbsReference ?? null,
      pendingApproval: approval ? { changeId: approval.id, requestedAt: approval.createdAt.toISOString() } : null,
    };
  });

  return NextResponse.json({ page, limit, total, totalPages: Math.ceil(total / limit), status: filter.key, rows });
}
