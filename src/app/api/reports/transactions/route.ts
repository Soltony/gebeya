import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { calculateTotalRepayable } from "@/lib/loan-calculator";
import { addDays, endOfDay, isValid, startOfDay, subDays } from "date-fns";
import { getUserFromSession } from "@/lib/user";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromSession();
    if (!user || !user.permissions?.["reports"]?.read) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const url = new URL(request.url);
    let providerId = url.searchParams.get("providerId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rawSearch = url.searchParams.get("search");
    const search = rawSearch?.trim() || "";

    // Pagination parameters
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(url.searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10))
    );
    const skip = (page - 1) * pageSize;

    const isSuperAdminOrRecon =
      user.role === "Super Admin" || user.role === "Reconciliation";
    
    // Users with loanProviderId are restricted to their own provider
    // Users without loanProviderId (and with reports permission) can access all providers
    if (user.loanProviderId) {
      providerId = user.loanProviderId;
    }

    const taxConfig = await prisma.tax.findMany();

    const whereAny: any = {
      loanId: { not: null },
      loan: { repaymentStatus: { not: "REVERSED" } },
    };
    if (providerId && providerId !== "all" && providerId !== "none") {
      whereAny.providerId = providerId;
    }
    if (providerId === "none") {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize, totalPages: 0 });
    }

    if (from || to) {
      whereAny.date = {};
      if (from) {
        const d = new Date(from);
        if (isValid(d)) whereAny.date.gte = startOfDay(d);
      }
      if (to) {
        const d = new Date(to);
        if (isValid(d)) whereAny.date.lte = endOfDay(d);
      }
    }

    const type = url.searchParams.get("type");

    if (type === "repayment") {
      whereAny.payment = { isNot: null };
    } else if (type === "disbursement") {
      whereAny.payment = { is: null };
    }

    // Server-side search (best-effort):
    // - Phone number (loan.borrowerId is the borrower phone number in this system)
    // - Account number (via PhoneAccount.accountNumber lookup -> mapped to phoneNumber -> loan.borrowerId)
    // - LoanId / JournalEntry id
    if (search) {
      const matchedPhoneNumbers = new Set<string>();

      // Find borrowers by phone/account number.
      const phoneMatches = await prisma.phoneAccount.findMany({
        where: {
          OR: [
            { phoneNumber: { contains: search } },
            { accountNumber: { contains: search } },
          ],
        },
        select: { phoneNumber: true },
        take: 200,
      });
      for (const p of phoneMatches) {
        if (p.phoneNumber) matchedPhoneNumbers.add(p.phoneNumber);
      }

      const or: any[] = [
        { id: { contains: search } },
        { loanId: { contains: search } },
      ];

      // If they search by last 8 characters, match "endsWith" too.
      if (search.length <= 12) {
        or.push({ loanId: { endsWith: search } });
        or.push({ id: { endsWith: search } });
      }

      if (matchedPhoneNumbers.size > 0) {
        or.push({
          loan: { borrowerId: { in: Array.from(matchedPhoneNumbers) } },
        });
      }

      // Merge with existing WHERE.
      whereAny.OR = or;
    }

    // Get total count for pagination
    const totalCount = await prisma.journalEntry.count({ where: whereAny });
    const totalPages = Math.ceil(totalCount / pageSize);

    const journalEntries = await prisma.journalEntry.findMany({
      where: whereAny,
      include: {
        loan: {
          include: {
            product: {
              include: { provider: { include: { ledgerAccounts: true } } },
            },
            borrower: {
              include: {
                provisionedData: { orderBy: { createdAt: "desc" }, take: 1 },
              },
            },
          },
        },
        entries: { include: { ledgerAccount: true } },
        payment: true,
      },
      orderBy: { date: "desc" },
      skip,
      take: pageSize,
    });

    const borrowerIds = Array.from(
      new Set(
        journalEntries.map((j) => (j.loan as any)?.borrowerId).filter(Boolean)
      )
    );
    // Fetch phone accounts with deterministic ordering: prefer isActive first, then most recent
    // This ensures consistent account selection when borrowers have multiple accounts
    const phoneAccounts =
      borrowerIds.length > 0
        ? await prisma.phoneAccount.findMany({
            where: { phoneNumber: { in: borrowerIds } },
            orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
          })
        : [];
    // Build map preferring the first (best) account per borrower
    const phoneAccountMap = new Map<string, (typeof phoneAccounts)[0]>();
    for (const p of phoneAccounts) {
      if (!phoneAccountMap.has(p.phoneNumber)) {
        phoneAccountMap.set(p.phoneNumber, p);
      }
    }

    const providerIds = Array.from(
      new Set(journalEntries.map((j) => j.providerId).filter(Boolean))
    ) as string[];
    const loanIds = Array.from(
      new Set(journalEntries.map((j) => j.loanId).filter(Boolean))
    ) as string[];

    const disbursementSelect = {
      id: true,
      transactionId: true,
      loanId: true,
      providerId: true,
      originalProviderId: true,
      creditAccount: true,
      amount: true,
      statusCode: true,
      disbursementStatus: true,
      createdAt: true,
    } as any;

    // 1) Strong match: load disbursement transactions by loanId (no date limit)
    const disbursementTxsByLoanId = loanIds.length
      ? await prisma.disbursementTransaction.findMany({
          where: { loanId: { in: loanIds } },
          select: disbursementSelect,
        })
      : [];

    // 2) Fallback match: provider-based window near the current page's JE dates
    const disbursementWhere: any = {};
    if (providerIds.length > 0) {
      disbursementWhere.OR = [
        { providerId: { in: providerIds } },
        { originalProviderId: { in: providerIds } },
      ];
    }
    const jeDates = journalEntries.map((j) => j.date).filter(Boolean) as Date[];
    if (jeDates.length > 0) {
      const minJe = new Date(Math.min(...jeDates.map((d) => d.getTime())));
      const maxJe = new Date(Math.max(...jeDates.map((d) => d.getTime())));
      disbursementWhere.createdAt = {
        gte: startOfDay(subDays(minJe, 2)),
        lte: endOfDay(addDays(maxJe, 2)),
      };
    } else {
      // fallback to recent window when no JE dates are available
      disbursementWhere.createdAt = { gte: subDays(new Date(), 90) };
    }

    const disbursementTxsRecent = providerIds.length
      ? await prisma.disbursementTransaction.findMany({
          where: disbursementWhere,
          select: disbursementSelect,
        })
      : [];

    // Merge and de-duplicate
    const disbursementTxsMap = new Map<string, any>();
    for (const d of [...disbursementTxsByLoanId, ...disbursementTxsRecent]) {
      if (!disbursementTxsMap.has(d.id)) disbursementTxsMap.set(d.id, d);
    }
    const disbursementTxs = Array.from(disbursementTxsMap.values());

    // Create map by loanId for direct matching (highest priority)
    const disbByLoanId = new Map<string, any>();
    for (const d of disbursementTxs) {
      const loanId = (d as any).loanId;
      if (!loanId) continue;
      const existing = disbByLoanId.get(loanId);
      if (!existing) {
        disbByLoanId.set(loanId, d);
        continue;
      }
      const existingHasAccount = Boolean(existing.creditAccount);
      const candidateHasAccount = Boolean(d.creditAccount);
      const existingTime = new Date(existing.createdAt || 0).getTime();
      const candidateTime = new Date(d.createdAt || 0).getTime();

      // Prefer records with creditAccount; otherwise prefer the most recent
      if (candidateHasAccount && !existingHasAccount) {
        disbByLoanId.set(loanId, d);
      } else if (candidateHasAccount === existingHasAccount && candidateTime > existingTime) {
        disbByLoanId.set(loanId, d);
      }
    }

    // Create map by account for fallback matching
    const disbMap = new Map<string, any[]>();
    for (const d of disbursementTxs) {
      const rawKey = String(d.creditAccount || "").trim();
      const normalizedKey = rawKey.replace(/\D/g, "").replace(/^0+/, "");
      const keys = Array.from(new Set([rawKey, normalizedKey].filter(Boolean)));
      for (const key of keys) {
        if (!disbMap.has(key)) disbMap.set(key, []);
        disbMap.get(key)!.push(d);
      }
    }

    const rows = await Promise.all(
      journalEntries.map(async (je) => {
        const loan = je.loan as any;
        const provider = loan?.product?.provider;

        const totals = loan
          ? calculateTotalRepayable(
              loan as any,
              loan.product as any,
              taxConfig,
              je.date
            )
          : {
              total: 0,
              principal: 0,
              interest: 0,
              serviceFee: 0,
              penalty: 0,
              tax: 0,
            };

        let collected: Record<string, number> = {
          Principal: 0,
          Interest: 0,
          ServiceFee: 0,
          Penalty: 0,
          Tax: 0,
        };
        if (loan) {
          const agg = await prisma.ledgerEntry.groupBy({
            by: ["ledgerAccountId"],
            where: {
              journalEntry: { loanId: loan.id, date: { lte: je.date } },
              ledgerAccount: { type: "Received" },
            },
            _sum: { amount: true },
          });
          for (const g of agg) {
            try {
              const la = await prisma.ledgerAccount.findUnique({
                where: { id: g.ledgerAccountId },
              });
              if (!la) continue;
              const cat = la.category as string;
              collected[cat] = (collected[cat] || 0) + (g._sum.amount || 0);
            } catch (e) {}
          }
        }

        const principalDisbursed = loan?.loanAmount || 0;
        const principalOutstanding = Math.max(
          0,
          (totals.principal || 0) - (collected["Principal"] || 0)
        );
        const interestOutstanding = Math.max(
          0,
          (totals.interest || 0) - (collected["Interest"] || 0)
        );
        const serviceFeeOutstanding = Math.max(
          0,
          (totals.serviceFee || 0) - (collected["ServiceFee"] || 0)
        );
        const penaltyOutstanding = Math.max(
          0,
          (totals.penalty || 0) - (collected["Penalty"] || 0)
        );
        const totalOutstanding =
          principalOutstanding +
          interestOutstanding +
          serviceFeeOutstanding +
          penaltyOutstanding;

        // For repayments: calculate transaction-specific paid amounts from THIS journal entry's ledger entries
        // (not cumulative totals from all payments)
        let principalPaid = 0;
        let interestPaid = 0;
        let serviceFeePaid = 0;
        let penaltyPaid = 0;

        if (je.payment) {
          // This is a repayment - get amounts from THIS specific transaction's ledger entries
          for (const entry of je.entries) {
            if (entry.ledgerAccount?.type === "Received") {
              const category = entry.ledgerAccount?.category as string;
              const amount = entry.amount || 0;
              if (category === "Principal") principalPaid += amount;
              else if (category === "Interest") interestPaid += amount;
              else if (category === "ServiceFee") serviceFeePaid += amount;
              else if (category === "Penalty") penaltyPaid += amount;
            }
          }
        } else {
          // For non-repayment transactions, use cumulative collected amounts
          principalPaid = collected["Principal"] || 0;
          interestPaid = collected["Interest"] || 0;
          serviceFeePaid = collected["ServiceFee"] || 0;
          penaltyPaid = collected["Penalty"] || 0;
        }

        const totalPaid =
          principalPaid + interestPaid + serviceFeePaid + penaltyPaid;

        const configuredDebit = (je.loan as any)?.product?.provider?.accountNumber || null;
        let debitAccounts = configuredDebit
          ? [configuredDebit]
          : (je.entries
              .filter((e) => e.type === "Debit")
              .map((e) => e.ledgerAccount?.name)
              .filter(Boolean) as string[]);
        let creditAccounts = je.entries
          .filter((e) => e.type === "Credit")
          .map((e) => e.ledgerAccount?.name)
          .filter(Boolean);

        const providerLedgerAccounts =
          (je.loan as any)?.product?.provider?.ledgerAccounts || [];
        const disbursementAccount =
          providerLedgerAccounts.find(
            (a: any) => a.category === "Principal" && a.type !== "Receivable"
          ) ||
          providerLedgerAccounts.find((a: any) =>
            /fund|cash|disburse/i.test(a.name)
          ) ||
          providerLedgerAccounts.find((a: any) => a.type === "Received") ||
          providerLedgerAccounts.find((a: any) => a.type === "Income") ||
          null;

        const isDisbursement =
          type === "disbursement" || (!je.payment && !type);
        if (isDisbursement && disbursementAccount)
          creditAccounts = [disbursementAccount.name];

        let customerName: string | null = null;
        try {
          const pa =
            loan && loan.borrowerId
              ? phoneAccountMap.get(loan.borrowerId)
              : null;
          if (pa) customerName = pa.customerName || null;
          if (!customerName) {
            const pd = loan?.borrower?.provisionedData?.[0]?.data;
            if (pd) {
              const parsed = JSON.parse(pd);
              customerName =
                parsed.fullName || parsed.name || parsed.customerName || null;
            }
          }
        } catch (e) {}

        let transactionStatus = je.payment ? "COMPLETED" : "POSTED";
        let reference = je.id;

        // For repayments: resolve the CBS transaction reference (FT number) from PaymentTransaction
        // Similar to how disbursements get cbsReference from DisbursementTransaction.transactionId
        // Each partial repayment has its own TxRef in the journal entry description
        if (je.payment && loan?.id) {
          try {
            // 1) FIRST: Extract TxRef from journal entry description (unique per payment)
            // The description contains "via TxRef {txnRef}" which is specific to this payment
            const desc = String((je as any).description || "");
            const m = desc.match(/TxRef\s*[:#]?\s*([A-Za-z0-9-]+)/i);
            if (m && m[1]) {
              const foundTxnRef = m[1];
              // Look up PaymentTransaction by txnRef to get the FT number
              const pt = await prisma.paymentTransaction.findFirst({
                where: { txnRef: foundTxnRef } as any,
              });
              if (pt && pt.transactionId && /^FT/i.test(pt.transactionId)) {
                reference = pt.transactionId;
              }
            }

            // 2) If still default, try to match by payment date and amount via PendingPayment
            if (reference === je.id && je.payment) {
              const paymentDate = new Date(je.payment.date);
              const paymentAmount = je.payment.amount;

              // Find PendingPayment that matches this specific payment's date/amount
              const matchingPending = await prisma.pendingPayment.findFirst({
                where: {
                  loanId: loan.id,
                  status: "COMPLETED",
                  amount: paymentAmount,
                  updatedAt: {
                    gte: new Date(paymentDate.getTime() - 60000), // within 1 minute
                    lte: new Date(paymentDate.getTime() + 60000),
                  },
                },
                orderBy: { updatedAt: "desc" },
              });

              if (matchingPending && matchingPending.transactionId) {
                const pt = await prisma.paymentTransaction.findFirst({
                  where: { txnRef: matchingPending.transactionId } as any,
                });
                if (pt && pt.transactionId && /^FT/i.test(pt.transactionId)) {
                  reference = pt.transactionId;
                }
              }
            }
          } catch (e) {
            // ignore lookup errors and keep default reference
          }
        }

        // --- Disbursement Matching: First by loanId, then by Account + Amount + Date ±3 minutes ---
        let cbsReference: string | null = null;
        let cbsCreditAmount: number | null = null;
        let disbursementCreatedAt: Date | null = null;
        let disbursementStatusCode: number | null = null;
        let disbursementRawResponse: string | null = null;
        let disbursementStatusText: string | null = null;
        let disbursementOutcome: string | null = null;
        let borrowerAccount: string | null = null;
        let disbursementCreditAccount: string | null = null;

        if (loan && loan.borrowerId) {
          const pa = phoneAccountMap.get(loan.borrowerId) || null;
          borrowerAccount = pa?.accountNumber || null;
          if (!borrowerAccount) {
            try {
              const pd = loan?.borrower?.provisionedData?.[0]?.data;
              if (pd) {
                const parsed = JSON.parse(pd);
                borrowerAccount =
                  parsed.accountNumber ||
                  parsed.account ||
                  parsed.customerAccount ||
                  parsed.account_no ||
                  borrowerAccount;
              }
            } catch (e) {}
          }

          let foundMatch: any = null;

          // 1️⃣ PRIORITY: Direct match by loanId from DisbursementTransaction table
          if (loan.id && disbByLoanId.has(loan.id)) {
            foundMatch = disbByLoanId.get(loan.id);
          }

          // 2️⃣ FALLBACK: Match by Account + Amount + Timestamp if no direct loanId match
          if (!foundMatch) {
            const normalizedBorrowerAcc = String(borrowerAccount || "")
              .replace(/\D/g, "")
              .replace(/^0+/, "");
            const candidates =
              disbMap.get(String(normalizedBorrowerAcc)) ||
              disbMap.get(String(borrowerAccount)) ||
              [];

            if (candidates.length > 0) {
              // Filter by exact amount
              const amountMatches = candidates.filter(
                (c) => Math.abs((c.amount || 0) - principalDisbursed) < 0.01
              );

              // Filter by timestamp ±3 minutes
              const matches = amountMatches.filter((c) => {
                const jeTime = new Date(je.date).getTime();
                const cTime = new Date(c.createdAt).getTime();
                return Math.abs(jeTime - cTime) <= 3 * 60 * 1000; // 3 minutes in ms
              });

              // Pick the closest timestamp
              if (matches.length > 0) {
                let best = matches[0];
                let bestDiff = Math.abs(
                  new Date(best.createdAt).getTime() -
                    new Date(je.date).getTime()
                );
                for (const c of matches) {
                  const diff = Math.abs(
                    new Date(c.createdAt).getTime() -
                      new Date(je.date).getTime()
                  );
                  if (diff < bestDiff) {
                    bestDiff = diff;
                    best = c;
                  }
                }
                foundMatch = best;
              }
            }
          }

          // --- Assign matched disbursement record ---
          if (foundMatch) {
            const match = foundMatch;
            disbursementCreatedAt = match.createdAt ?? null;
            disbursementStatusCode = match.statusCode ?? null;
            const matchDisbursementStatus = match.disbursementStatus ?? null;
            // rawResponse and responsePayload are excluded from the query to avoid large string issues
            disbursementRawResponse = null;

            // Always capture the CBS transactionId if available (even for failures)
            // This ensures the report shows the same reference as the reversals page
            cbsReference = match.transactionId ?? null;

            // Store the DisbursementTransaction credit account separately
            // so reports can show "Credit Account" (where funds went) and
            // "Customer Account" (borrower's own bank account) as distinct columns.
            if (match.creditAccount) {
              disbursementCreditAccount = match.creditAccount;
            }

            // Determine status: prefer disbursementStatus field (SUCCESS/FAILED), fallback to statusCode
            if (matchDisbursementStatus === "SUCCESS" || 
                (disbursementStatusCode !== null && disbursementStatusCode >= 200 && disbursementStatusCode < 300)) {
              disbursementStatusText = "Success";
              disbursementOutcome = "Success";
              cbsCreditAmount = match.amount ?? null;
              transactionStatus = "SUCCESS";
            } else if (matchDisbursementStatus === "FAILED" || 
                       (disbursementStatusCode !== null && (disbursementStatusCode < 200 || disbursementStatusCode >= 300))) {
              disbursementStatusText = disbursementStatusCode !== null 
                ? `Status ${disbursementStatusCode}` 
                : "Failed";
              disbursementOutcome = "Failure";
              cbsCreditAmount = 0;
              transactionStatus = "FAILED";
            } else if (matchDisbursementStatus === "PENDING" || matchDisbursementStatus === "SENT") {
              disbursementStatusText = matchDisbursementStatus;
              disbursementOutcome = "Pending";
              transactionStatus = "PENDING";
            }
          }
        }

        return {
          provider: provider?.name || null,
          providerId: provider?.id || null,
          loanId: loan?.id || null,
          customerName,
          transactionDate: je.date,
          dueDate: loan?.dueDate || null,
          debitAccount: debitAccounts.join(", "),
          creditAccount: creditAccounts.join(", "),
          transactionStatus,
          reference,
          productType: loan?.product?.name || null,
          borrowerId: loan?.borrowerId || null,
          borrowerAccount,
          disbursementCreditAccount,
          principalDisbursed,
          netDisbursed: principalDisbursed,
          principalOutstanding,
          interestOutstanding,
          serviceFeeOutstanding,
          penaltyOutstanding,
          totalOutstanding,
          // Paid amounts for repayment reports
          principalPaid,
          interestPaid,
          serviceFeePaid,
          penaltyPaid,
          totalPaid,
          status: loan?.repaymentStatus || null,
          cbsReference,
          cbsCreditAmount,
          disbursementCreatedAt,
          disbursementStatusCode,
          disbursementRawResponse,
          disbursementStatusText,
          disbursementOutcome,
        };
      })
    );

    return NextResponse.json({
      data: rows,
      total: totalCount,
      page,
      pageSize,
      totalPages,
    });
  } catch (error: any) {
    console.error("Transactions report error", error);
    return NextResponse.json(
      { message: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
