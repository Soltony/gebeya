"use server";

import prisma from "@/lib/prisma";
import { getUserFromSession } from "@/lib/user";
import { redirect } from "next/navigation";
import { MerchantApprovalsClient } from "./client";

export default async function MerchantApprovalsPage() {
  const user = await getUserFromSession();
  if (!user) redirect("/api/auth/login");

  const changes = await prisma.pendingChange.findMany({
    where: {
      status: "PENDING",
      entityType: { in: ["Merchant", "MerchantItem", "MerchantDiscountRule", "MerchantLocation"] },
    },
    include: {
      createdBy: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phoneNumber: true,
          roleId: true,
          status: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const serialised = changes.map((c) => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    createdBy: c.createdBy
      ? {
          id: c.createdBy.id,
          fullName: c.createdBy.fullName,
          email: c.createdBy.email,
        }
      : null,
  }));

  return <MerchantApprovalsClient changes={serialised} />;
}
