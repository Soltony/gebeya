/**
 * GET /api/manual-repayments/search?q=<loan id | account number | telephone>
 *
 * Customer and loan search for the Maker: every loan the query matches that still
 * owes money, with the balance split and — importantly — the amount a single
 * repayment may settle right now (see loanBalanceSnapshot).
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { getAsOfDate } from '@/lib/date-utils';
import { handleApiError } from '@/lib/error-utils';
import { MONEY_EPSILON, loanBalanceSnapshot } from '@/lib/manual-repayment';
import { canEnterRepayment, canViewRepayments } from '@/lib/manual-repayment-access';

const MAX_RESULTS = 25;

/** Account numbers are looked up through PhoneAccount, which maps them to borrowers. */
async function borrowerIdsForAccountNumber(query: string) {
  const matches = await prisma.phoneAccount.findMany({
    where: { accountNumber: { contains: query } },
    select: { phoneNumber: true },
    take: 100,
    distinct: ['phoneNumber'],
  });
  return matches.map((m) => m.phoneNumber);
}

function borrowerName(provisionedData: { data: string }[]): string | null {
  for (const entry of provisionedData ?? []) {
    try {
      const data = JSON.parse(entry.data);
      const key = Object.keys(data).find((k) =>
        ['fullname', 'full name', 'customername', 'customer name'].includes(k.toLowerCase()),
      );
      if (key && data[key]) return String(data[key]);
    } catch {
      // A malformed provisioning payload is not a reason to fail the search.
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || (!canEnterRepayment(user) && !canViewRepayments(user))) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const query = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (query.length < 3) {
    return NextResponse.json(
      { error: 'Enter at least 3 characters of a loan ID, account number or telephone.' },
      { status: 400 },
    );
  }

  try {
    const accountBorrowerIds = await borrowerIdsForAccountNumber(query);

    const [loans, taxConfigs] = await Promise.all([
      prisma.loan.findMany({
        where: {
          repaymentStatus: { not: 'Paid' },
          OR: [
            { id: { contains: query } },
            { borrowerId: { contains: query } },
            ...(accountBorrowerIds.length ? [{ borrowerId: { in: accountBorrowerIds } }] : []),
          ],
        },
        include: {
          product: { include: { provider: { select: { id: true, name: true } } } },
          installments: { orderBy: { installmentNumber: 'asc' } },
          payments: { orderBy: { date: 'asc' } },
          borrower: { include: { provisionedData: { orderBy: { createdAt: 'desc' }, take: 5 } } },
        },
        orderBy: [{ disbursedDate: 'desc' }, { id: 'desc' }],
        take: MAX_RESULTS,
      }),
      prisma.tax.findMany({ where: { status: 'ACTIVE' } }),
    ]);

    const loanIds = loans.map((l) => l.id);
    const [accounts, openEntries] = await Promise.all([
      loans.length
        ? prisma.phoneAccount.findMany({
            where: { phoneNumber: { in: [...new Set(loans.map((l) => l.borrowerId))] } },
            select: { phoneNumber: true, accountNumber: true, isActive: true },
          })
        : Promise.resolve([]),
      // A loan already carrying an unapproved entry is flagged so two makers do
      // not key the same slip in while the first is still waiting for a checker.
      loanIds.length
        ? prisma.manualRepayment.findMany({
            where: { loanId: { in: loanIds }, status: 'PENDING_APPROVAL' },
            select: { loanId: true, amount: true, referenceNumber: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);

    const accountByPhone = new Map<string, string>();
    for (const a of accounts) {
      if (!accountByPhone.has(a.phoneNumber) || a.isActive) {
        accountByPhone.set(a.phoneNumber, a.accountNumber);
      }
    }
    const pendingByLoan = new Map(openEntries.map((e) => [e.loanId, e]));

    const asOfDate = getAsOfDate();
    const results = loans
      .map((loan) => {
        const balance = loanBalanceSnapshot(
          loan as never,
          loan.product,
          taxConfigs,
          loan.installments as never,
          asOfDate,
        );
        const pending = pendingByLoan.get(loan.id);
        return {
          loanId: loan.id,
          borrowerId: loan.borrowerId,
          customerName: borrowerName(loan.borrower?.provisionedData ?? []),
          telephone: loan.borrowerId,
          accountNumber: accountByPhone.get(loan.borrowerId) ?? null,
          productName: loan.product?.name ?? null,
          providerName: loan.product?.provider?.name ?? null,
          loanAmount: loan.loanAmount,
          repaidAmount: loan.repaidAmount ?? 0,
          disbursedDate: loan.disbursedDate.toISOString(),
          dueDate: loan.dueDate.toISOString(),
          repaymentStatus: loan.repaymentStatus,
          outstanding: balance,
          pendingEntry: pending
            ? {
                amount: pending.amount,
                referenceNumber: pending.referenceNumber,
                submittedAt: pending.createdAt.toISOString(),
              }
            : null,
        };
      })
      .filter((r) => r.outstanding.payableNow > MONEY_EPSILON);

    return NextResponse.json({ results, asOf: asOfDate.toISOString() });
  } catch (error) {
    return handleApiError(error, { operation: 'GET /api/manual-repayments/search' });
  }
}
