"use server";

import { getUserFromSession } from "@/lib/user";
import prisma from "@/lib/prisma";
import type { PendingChange, User } from "@prisma/client";
import { PendingPaymentApprovalsClient } from "./client";

const ITEMS_PER_PAGE = 10;

export type PendingPaymentApproval = PendingChange & {
  createdBy: Pick<
    User,
    | "id"
    | "fullName"
    | "email"
    | "phoneNumber"
    | "roleId"
    | "loanProviderId"
    | "status"
    | "createdAt"
  >;
  entityName: string;
  providerName?: string;
  /** What approving does, e.g. "Mark Order Payment Paid". */
  requestLabel: string;
};

// Loan repayments (BNPL) and order payments (USSD push / super-app gateway).
const RESOLVE_ENTITY_TYPES = ["PendingPaymentResolve", "DirectPaymentResolve"];

export type PaginatedPendingPaymentApprovals = {
  data: PendingPaymentApproval[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

async function getPendingPaymentApprovals(
  page: number = 1
): Promise<PaginatedPendingPaymentApprovals> {
  const skip = (page - 1) * ITEMS_PER_PAGE;

  const [total, changes] = await Promise.all([
    prisma.pendingChange.count({
      where: {
        status: "PENDING",
        entityType: { in: RESOLVE_ENTITY_TYPES },
      },
    }),
    prisma.pendingChange.findMany({
      where: {
        status: "PENDING",
        entityType: { in: RESOLVE_ENTITY_TYPES },
      },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phoneNumber: true,
            roleId: true,
            loanProviderId: true,
            status: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: ITEMS_PER_PAGE,
    }),
  ]);

  const detailed = changes.map((change) => {
    let entityName = change.entityId || "N/A";
    let providerName: string | undefined;
    const isOrderPayment = change.entityType === "DirectPaymentResolve";
    const requestLabel = isOrderPayment ? "Mark Order Payment Paid" : "Mark Payment Successful";

    try {
      const data = JSON.parse(change.payload);
      const created = data?.created;
      if (created && isOrderPayment) {
        entityName =
          [
            created.orderRef ? `Order ${created.orderRef}` : null,
            created.borrowerId ? `Customer ${created.borrowerId}` : null,
            created.merchantName ? String(created.merchantName) : null,
            created.transactionId ? `Ref ${created.transactionId}` : null,
          ]
            .filter(Boolean)
            .join(" • ") || entityName;
        providerName = created.method === "USSD_PUSH" ? "USSD push" : "Super app";
      } else if (created) {
        const borrowerId = created.borrowerId
          ? String(created.borrowerId)
          : null;
        const loanId = created.loanId ? String(created.loanId) : null;
        const amount = created.amount != null ? Number(created.amount) : null;
        const ftRef = created.ftReference ? String(created.ftReference) : null;

        entityName =
          [
            borrowerId ? `Borrower ${borrowerId}` : null,
            loanId ? `Loan ${loanId}` : null,
            amount != null ? `Amt ${amount}` : null,
            ftRef ? `FT ${ftRef}` : null,
          ]
            .filter(Boolean)
            .join(" • ") || entityName;

        if (created.providerName) {
          providerName = String(created.providerName);
        }
      }
    } catch {
      // ignore
    }

    return {
      ...change,
      entityName,
      providerName,
      requestLabel,
    } as PendingPaymentApproval;
  });

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  return {
    data: detailed,
    total,
    page,
    pageSize: ITEMS_PER_PAGE,
    totalPages,
  };
}

export default async function PendingPaymentApprovalsPage({
  searchParams,
}: {
  searchParams: { page?: string } | Promise<{ page?: string }>;
}) {
  const user = await getUserFromSession();
  if (!user) return <div>Not authenticated</div>;

  const resolvedSearchParams = await searchParams;
  const page = Math.max(1, parseInt(resolvedSearchParams?.page || "1", 10));
  const paginatedData = await getPendingPaymentApprovals(page);

  return (
    <PendingPaymentApprovalsClient
      paginatedData={paginatedData}
      currentUser={user}
    />
  );
}
