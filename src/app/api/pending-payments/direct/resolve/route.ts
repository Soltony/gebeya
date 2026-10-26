import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromSession } from "@/lib/user";
import { createAuditLog } from "@/lib/audit-log";
import { orderRef } from "@/lib/marketplace/order-status";
import { isResolvableDirectPaymentStatus } from "@/lib/direct-payment-status";

const FT_PATTERN = /^[A-Z0-9]{6,32}$/;

/**
 * POST /api/pending-payments/direct/resolve
 *
 * Creates a maker-checker request to mark an order payment as paid, for when
 * the customer was debited but the bank never reported it to us (no callback,
 * no usable status). The payment is only recorded once a second user approves
 * the request (see the DirectPaymentResolve case in /api/approvals).
 *
 * Body: { directPendingPaymentId: string, ftReference: string }
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (
    !user ||
    (!user.permissions?.["pending-payments"]?.update &&
      !user.permissions?.["approvals"]?.update &&
      !user.permissions?.["reversals"]?.update)
  ) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const ipAddress = (req as any).ip || req.headers.get("x-forwarded-for") || "N/A";
  const userAgent = req.headers.get("user-agent") || "N/A";

  const body = await req.json().catch(() => null);
  const paymentId = body?.directPendingPaymentId ? String(body.directPendingPaymentId).trim() : null;
  const ftReference = body?.ftReference ? String(body.ftReference).trim().toUpperCase() : null;
  if (!paymentId || !ftReference) {
    return NextResponse.json({ error: "Missing directPendingPaymentId or ftReference" }, { status: 400 });
  }
  if (!FT_PATTERN.test(ftReference)) {
    return NextResponse.json({ error: "The FT reference should be 6-32 letters and digits, e.g. FT252748HG7N." }, { status: 400 });
  }

  const payment = await prisma.directPendingPayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      transactionId: true,
      method: true,
      status: true,
      amount: true,
      orderId: true,
      borrowerId: true,
      createdAt: true,
      merchant: { select: { name: true } },
    },
  });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (!isResolvableDirectPaymentStatus(payment.status)) {
    return NextResponse.json({ error: "This payment is already confirmed." }, { status: 409 });
  }

  // An FT can settle only one payment.
  const ftOwner = await prisma.directPaymentFt.findUnique({ where: { cbsReference: ftReference } });
  if (ftOwner && ftOwner.directPendingPaymentId !== payment.id) {
    return NextResponse.json({ error: `FT ${ftReference} is already recorded against another payment.` }, { status: 409 });
  }

  const existing = await prisma.pendingChange.findFirst({
    where: { status: "PENDING", entityType: "DirectPaymentResolve", entityId: payment.id },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ ok: true, message: "A resolution request is already pending approval", changeId: existing.id });
  }

  const pendingChange = await prisma.pendingChange.create({
    data: {
      entityType: "DirectPaymentResolve",
      entityId: payment.id,
      changeType: "CREATE",
      payload: JSON.stringify({
        created: {
          directPendingPaymentId: payment.id,
          transactionId: payment.transactionId,
          method: payment.method,
          ftReference,
          orderId: payment.orderId,
          orderRef: orderRef(payment.orderId),
          borrowerId: payment.borrowerId,
          merchantName: payment.merchant.name,
          amount: payment.amount,
          paymentDate: payment.createdAt.toISOString(),
          statusBefore: payment.status,
        },
      }),
      createdById: user.id,
    },
  });

  await createAuditLog({
    actorId: user.id,
    action: "DIRECT_PAYMENT_RESOLVE_REQUESTED",
    entity: "ORDER",
    entityId: payment.orderId,
    details: { directPendingPaymentId: payment.id, transactionId: payment.transactionId, ftReference, amount: payment.amount, changeId: pendingChange.id },
    ipAddress,
    userAgent,
  });

  return NextResponse.json({ ok: true, message: "Resolve request submitted for approval", changeId: pendingChange.id });
}
