import { NextResponse } from "next/server";
import prisma from "../../../../lib/prisma";
import sendSms from "@/lib/sms";
import { areDisbursementsEnabled } from "@/lib/disbursement-control";
import {
  auditExternalApiError,
  auditExternalApiRequest,
  auditExternalApiResponse,
  newAuditCorrelationId,
} from "@/lib/audit-log";

type Body = {
  creditAccount: string;
  providerId: string;
  amount: string | number;
  loanId?: string;
};

// Helper to find existing DisbursementTransaction by loanId or create new one
async function findOrCreateDisbursementTransaction(
  loanId: string | undefined,
  data: {
    providerId: string;
    originalProviderId?: string;
    creditAccount: string;
    amount?: number;
    requestPayload: string;
    responsePayload?: string;
    rawResponse?: string;
    statusCode?: number | null;
    transactionId?: string | null;
    disbursementStatus: string;
  }
) {
  // If loanId is provided, try to find existing PENDING record and update it
  if (loanId) {
    const existing = await prisma.disbursementTransaction.findFirst({
      where: {
        loanId,
        disbursementStatus: "PENDING",
      } as any, // Type assertion until Prisma client is regenerated
    });

    if (existing) {
      return await prisma.disbursementTransaction.update({
        where: { id: existing.id },
        data: {
          transactionId: data.transactionId ?? undefined,
          providerId: data.providerId,
          originalProviderId: data.originalProviderId,
          creditAccount: data.creditAccount,
          amount: data.amount,
          disbursementStatus: data.disbursementStatus,
          requestPayload: data.requestPayload,
          responsePayload: data.responsePayload,
          rawResponse: data.rawResponse,
          statusCode: data.statusCode,
        } as any, // Type assertion until Prisma client is regenerated
      });
    }
  }

  // No existing record found, create new one
  return await prisma.disbursementTransaction.create({
    data: {
      loanId: loanId ?? undefined,
      transactionId: data.transactionId ?? undefined,
      providerId: data.providerId,
      originalProviderId: data.originalProviderId,
      creditAccount: data.creditAccount,
      amount: data.amount,
      disbursementStatus: data.disbursementStatus,
      requestPayload: data.requestPayload,
      responsePayload: data.responsePayload,
      rawResponse: data.rawResponse,
      statusCode: data.statusCode,
    } as any, // Type assertion until Prisma client is regenerated
  });
}

export async function POST(req: Request) {
  try {
    const ipAddress = req.headers.get("x-forwarded-for") || "N/A";
    const userAgent = req.headers.get("user-agent") || "N/A";
    const actorId = "system";

    const enabled = await areDisbursementsEnabled();
    if (!enabled) {
      // Parse body to get loanId so we can update any PENDING record
      try {
        const body: Body = await req.clone().json();
        if (body.loanId) {
          const existing = await prisma.disbursementTransaction.findFirst({
            where: { loanId: body.loanId, disbursementStatus: "PENDING" } as any,
          });
          if (existing) {
            await prisma.disbursementTransaction.update({
              where: { id: existing.id },
              data: {
                disbursementStatus: "FAILED",
                responsePayload: JSON.stringify({ error: "Disbursements are currently disabled." }),
                rawResponse: "Disbursements are currently disabled.",
                statusCode: 503,
              } as any,
            });
          }
        }
      } catch (_) {
        // best-effort; don't block the 503 response
      }
      return NextResponse.json(
        { error: "Disbursements are currently disabled." },
        { status: 503 }
      );
    }

    const body: Body = await req.json();
    const { creditAccount: requestedCreditAccount, providerId, amount, loanId } = body;
    // For testing: force the provider id to PRO0002 unless overridden by env
    const forcedProviderId = process.env.FORCE_PROVIDER_ID ?? "PRO0002";
    const sendProviderId = forcedProviderId;
    if (!requestedCreditAccount || !providerId || !amount)
      return NextResponse.json(
        { error: "creditAccount, providerId and amount are required" },
        { status: 400 }
      );

    // ── BNPL: If the loan has an associated order, credit the merchant instead of the borrower ──
    let creditAccount = requestedCreditAccount;
    if (loanId) {
      try {
        const order = await prisma.order.findFirst({
          where: { loanId },
          include: { merchant: { select: { accountNumber: true, name: true } } },
        });
        if (order?.merchant?.accountNumber) {
          console.log(
            `[external][disbursement] BNPL order detected – crediting merchant "${order.merchant.name}" (${order.merchant.accountNumber}) instead of borrower (${requestedCreditAccount})`
          );
          creditAccount = order.merchant.accountNumber;
        }
      } catch (e) {
        console.error("[external][disbursement] failed to resolve merchant account, falling back to borrower", e);
      }
    }

    const apiUrl = process.env.EXTERNAL_DISBURSEMENT_URL;
    const user = process.env.EXTERNAL_API_USERNAME;
    const pass = process.env.EXTERNAL_API_PASSWORD;

    const auth =
      user && pass
        ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")
        : undefined;

    // Log outgoing request details (mask password)
    try {
      const maskedAuth = auth ? auth.replace(/:(.*)@/, ":*****@") : undefined;
    } catch (e) {
      // ignore logging errors
    }

    if (!apiUrl) {
      const errMsg = "Missing EXTERNAL_DISBURSEMENT_URL env var";
      console.error("[external][disbursement] config error", { error: errMsg });

      await auditExternalApiError(
        {
          actorId,
          ipAddress,
          userAgent,
          integration: "DISBURSEMENT",
          entity: "DisbursementTransaction",
        },
        errMsg,
        {
          request: {
            method: "POST",
            url: "EXTERNAL_DISBURSEMENT_URL",
            body: { creditAccount, providerId: sendProviderId, amount },
          },
        }
      ).catch(() => null);

      try {
        await findOrCreateDisbursementTransaction(loanId, {
          providerId: sendProviderId,
          originalProviderId: providerId ?? undefined,
          creditAccount: String(creditAccount),
          amount:
            typeof amount === "number"
              ? amount
              : Number(String(amount)) || undefined,
          requestPayload: JSON.stringify({
            creditAccount,
            providerId: sendProviderId,
            amount,
            loanId,
          }),
          responsePayload: JSON.stringify({ error: errMsg }),
          rawResponse: errMsg,
          statusCode: null,
          disbursementStatus: "FAILED",
        });
      } catch (e) {
        console.error(
          "[external][disbursement] failed to save disbursement transaction (missing url)",
          e
        );
      }
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    let res;
    const correlationId = newAuditCorrelationId();
    const startedAt = Date.now();
    try {
      await auditExternalApiRequest(
        {
          actorId,
          ipAddress,
          userAgent,
          integration: "DISBURSEMENT",
          entity: "DisbursementTransaction",
          correlationId,
        },
        {
          method: "POST",
          url: apiUrl,
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: auth } : {}),
          },
          body: { creditAccount, providerId: sendProviderId, amount },
        }
      ).catch(() => null);

      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          creditAccount,
          providerId: sendProviderId,
          amount,
        }),
      });

      const durationMs = Date.now() - startedAt;
      // We'll log the response body later once parsed.
      (res as any).__audit = { correlationId, durationMs };
    } catch (fetchErr: any) {
      const details = String(fetchErr?.message ?? fetchErr);
      console.error("[external][disbursement] fetch failed", {
        apiUrl,
        error: details,
      });

      await auditExternalApiError(
        {
          actorId,
          ipAddress,
          userAgent,
          integration: "DISBURSEMENT",
          entity: "DisbursementTransaction",
          correlationId,
        },
        fetchErr,
        {
          durationMs: Date.now() - startedAt,
          request: {
            method: "POST",
            url: apiUrl,
            headers: {
              "Content-Type": "application/json",
              ...(auth ? { Authorization: auth } : {}),
            },
            body: { creditAccount, providerId: sendProviderId, amount },
          },
        }
      ).catch(() => null);

      try {
        await findOrCreateDisbursementTransaction(loanId, {
          providerId: sendProviderId,
          originalProviderId: providerId ?? undefined,
          creditAccount: String(creditAccount),
          amount:
            typeof amount === "number"
              ? amount
              : Number(String(amount)) || undefined,
          requestPayload: JSON.stringify({
            creditAccount,
            providerId: sendProviderId,
            amount,
            loanId,
          }),
          responsePayload: JSON.stringify({
            error: "Upstream fetch failed",
            details,
          }),
          rawResponse: details,
          statusCode: null,
          disbursementStatus: "FAILED",
        });
      } catch (e) {
        console.error(
          "[external][disbursement] failed to save disbursement transaction (fetch error)",
          e
        );
      }

      return NextResponse.json(
        { error: "Upstream fetch failed", details },
        { status: 502 }
      );
    }

    const txt = await res.text().catch(() => null);
    // Try to parse JSON, fallback to text
    let payload: any = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch (e) {
      payload = txt;
    }

    try {
      const auditMeta = (res as any).__audit as
        | { correlationId?: string; durationMs?: number }
        | undefined;
      const correlationId = auditMeta?.correlationId ?? newAuditCorrelationId();
      await auditExternalApiResponse(
        {
          actorId,
          ipAddress,
          userAgent,
          integration: "DISBURSEMENT",
          entity: "DisbursementTransaction",
          correlationId,
        },
        {
          status: res.status,
          statusText: (res as any).statusText,
          headers: (() => {
            const headersObj: Record<string, string> = {};
            try {
              for (const [k, v] of (res.headers as any).entries()) {
                headersObj[k] = v;
              }
            } catch {
              // ignore
            }
            return headersObj;
          })(),
          body: payload,
          durationMs: auditMeta?.durationMs,
        }
      );
    } catch {
      // ignore audit failures
    }

    // Log upstream response for debugging
    try {
      const headersObj: Record<string, string> = {};
      try {
        // Response headers may be iterable
        for (const [k, v] of (res.headers as any).entries()) {
          headersObj[k] = v;
        }
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // ignore logging errors
    }

    // Persist disbursement transaction to DB for audit/reconciliation
    try {
      // extract transactionId if present
      let upstreamTransactionId: string | null = null;
      if (payload && typeof payload === "object") {
        upstreamTransactionId =
          payload.transactionId ??
          payload.transactionid ??
          payload.transaction_id ??
          null;
      } else if (typeof txt === "string") {
        const m =
          txt.match(
            /transactionId['"]?\s*[:=]\s*['"]?([A-Za-z0-9_-]+)['"]?/i
          ) || txt.match(/'transactionId'\s*:\s*'([^']+)'/i);
        if (m) upstreamTransactionId = m[1];
      }

      // Determine disbursement status based on response
      const isSuccess =
        res.ok &&
        (typeof res.status === "number"
          ? res.status >= 200 && res.status < 300
          : false);
      const disbursementStatus = isSuccess ? "SUCCESS" : "FAILED";

      await findOrCreateDisbursementTransaction(loanId, {
        transactionId: upstreamTransactionId ?? undefined,
        providerId: sendProviderId,
        originalProviderId: providerId ?? undefined,
        creditAccount: String(creditAccount),
        amount:
          typeof amount === "number"
            ? amount
            : Number(String(amount)) || undefined,
        requestPayload: JSON.stringify({
          creditAccount,
          providerId: sendProviderId,
          amount,
          loanId,
        }),
        responsePayload:
          typeof payload === "string"
            ? payload
            : payload
            ? JSON.stringify(payload)
            : undefined,
        rawResponse: txt ?? undefined,
        statusCode: typeof res.status === "number" ? res.status : undefined,
        disbursementStatus,
      }).catch((e) => {
        console.error(
          "[external][disbursement] failed to save disbursement transaction",
          e
        );
      });
    } catch (e) {
      console.error("[external][disbursement] saving transaction failed", e);
    }

    // Attempt to send SMS notification to the borrower (fire-and-forget)
    (async () => {
      try {
        // For BNPL orders (merchant credited), notify the borrower via their phone account
        // For regular loans (borrower credited), notify the borrower via the credited account
        let phoneNumber: string | null = null;
        const isMerchantCredit = creditAccount !== requestedCreditAccount;

        if (isMerchantCredit) {
          // BNPL: find borrower's phone via the original (borrower) account
          const phoneMap = await prisma.phoneAccount.findFirst({
            where: { accountNumber: String(requestedCreditAccount) },
          });
          phoneNumber = phoneMap?.phoneNumber ?? null;
        } else {
          // Regular: find phone via the credited account (borrower)
          const phoneMap = await prisma.phoneAccount.findFirst({
            where: { accountNumber: String(creditAccount) },
          });
          phoneNumber = phoneMap?.phoneNumber ?? null;
        }

        if (!phoneNumber) {
          // No mapping found; nothing to notify
          return;
        }

        // Compose message based on upstream result
        let message = "";
        const amt = amount ?? "";
        if (res.ok) {
          if (isMerchantCredit) {
            message = `Your BNPL loan of ETB ${amt} has been successfully disbursed to the merchant. Thank you for choosing NIBtera Loan.`;
          } else {
            message = `Your loan request of ETB ${amt} has been successfully disbursed to your account ${creditAccount}. Thank you for choosing NIBtera Loan.`;
          }
        } else {
          const reason =
            payload &&
            typeof payload === "object" &&
            (payload.message || payload.Message)
              ? payload.message || payload.Message
              : typeof payload === "string"
              ? payload
              : txt ?? "Unknown error";
          message = `Your loan request of ETB ${amt} could not be processed. Please try again later or contact NIBtera Loan support for assistance.`;
        }
        const smsRes = await sendSms(phoneNumber, message);
        if (!smsRes.ok)
          console.warn("[external][disbursement] sms send failed", smsRes);
      } catch (e) {
        console.error("[external][disbursement] sms notify failed", e);
      }
    })();

    if (!res.ok) {
      return NextResponse.json(
        { error: "Upstream error", status: res.status, body: payload },
        { status: 502 }
      );
    }

    return NextResponse.json(
      payload ?? { status: "OK", status_code: res.status },
      { status: res.status }
    );
  } catch (err: any) {
    console.error("[external][disbursement] error", err);
    return NextResponse.json(
      { error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
