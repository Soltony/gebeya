import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromSession } from "@/lib/user";
import { parseDayEnd, parseDayStart } from "@/lib/date-utils";

const REQUIRED_PERMS = ["npl-collection", "npl"] as const;

// Upper bound on rows returned to an export request, to keep the payload sane.
const EXPORT_ROW_CAP = 10000;

function userHasAnyPerm(user: any, action: "read" | "update"): boolean {
  if (!user?.permissions) return false;
  return REQUIRED_PERMS.some((key) => Boolean(user.permissions[key]?.[action]));
}

/** Paginated listing of received credit notifications. */
export async function GET(req: NextRequest) {
  const user = await getUserFromSession({ allowRefresh: false });
  if (!user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!userHasAnyPerm(user, "read")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  // `all=1` returns every matching row (capped) for spreadsheet exports.
  const exportAll = url.searchParams.get("all") === "1";
  const status = url.searchParams.get("status")?.trim();
  const search = url.searchParams.get("search")?.trim();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: any = {};
  if (status) where.processStatus = status;
  if (search) {
    where.OR = [
      { accountNumber: { contains: search } },
      { correlationId: { contains: search } },
      { externalReference: { contains: search } },
      { repayTransactionId: { contains: search } },
      { loanId: { contains: search } },
      { borrowerId: { contains: search } },
    ];
  }
  const fromDate = parseDayStart(from);
  const toDate = parseDayEnd(to);
  if (fromDate || toDate) {
    where.receivedAt = {};
    if (fromDate) where.receivedAt.gte = fromDate;
    if (toDate) where.receivedAt.lte = toDate;
  }

  const [total, rows, statusGroups, amounts] = await Promise.all([
    prisma.nplCreditNotification.count({ where }),
    prisma.nplCreditNotification.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: exportAll ? undefined : (page - 1) * limit,
      take: exportAll ? EXPORT_ROW_CAP : limit,
    }),
    exportAll
      ? Promise.resolve([])
      : prisma.nplCreditNotification.groupBy({ by: ["processStatus"], where, _count: { _all: true } }),
    exportAll
      ? Promise.resolve(null)
      : prisma.nplCreditNotification.aggregate({ where, _sum: { creditedAmount: true, repayDebitAmount: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const g of statusGroups) byStatus[g.processStatus] = g._count._all;

  return NextResponse.json({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    truncated: exportAll && total > EXPORT_ROW_CAP,
    summary: exportAll
      ? null
      : {
          total,
          byStatus,
          totalCredited: amounts?._sum.creditedAmount ?? 0,
          totalDebited: amounts?._sum.repayDebitAmount ?? 0,
        },
    rows: rows.map((n) => ({
      id: n.id,
      correlationId: n.correlationId,
      externalReference: n.externalReference,
      accountNumber: n.accountNumber,
      creditedAmount: n.creditedAmount,
      providerId: n.providerId,
      processStatus: n.processStatus,
      resultMessage: n.resultMessage,
      borrowerId: n.borrowerId,
      loanId: n.loanId,
      paymentId: n.paymentId,
      repayHttpStatus: n.repayHttpStatus,
      repayTransactionId: n.repayTransactionId,
      repayDebitAmount: n.repayDebitAmount,
      repayDebitAccount: n.repayDebitAccount,
      repayCreditAccount: n.repayCreditAccount,
      attempts: n.attempts,
      receivedAt: n.receivedAt.toISOString(),
      lastAttemptAt: n.lastAttemptAt?.toISOString() ?? null,
    })),
  });
}
