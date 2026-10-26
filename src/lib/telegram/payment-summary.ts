/**
 * What the Mini App shows about paying for a Telegram order, derived from the
 * order's payment attempts. No server dependencies, so client components can
 * import the types.
 */
import { maskPhone } from './phone';

/** A new prompt can be sent this long after the previous one. */
export const PAYMENT_RESEND_AFTER_SECONDS = 60;
/**
 * By then the customer has answered the prompt (or it timed out on the
 * phone). If the bank has not reported back, the customer may well have paid,
 * so the Mini App stops urging them to check their phone.
 */
export const PAYMENT_PROMPT_ANSWERED_SECONDS = 120;
/** Customers cannot cancel while a prompt this recent may still be approved. */
export const PAYMENT_CANCEL_BLOCK_MINUTES = 10;

export type TelegramPaymentState = 'UNPAID' | 'AWAITING_PIN' | 'PROCESSING' | 'PAID';

export type TelegramOrderPayment = {
  /** False when USSD push payments are not configured on the server. */
  enabled: boolean;
  /** False when the merchant has no NIB account on file to receive the payment. */
  merchantCanReceive: boolean;
  state: TelegramPaymentState;
  /** Whether the customer can send (or resend) a payment prompt now. */
  canPay: boolean;
  amount: number;
  /** Masked phone that receives the prompt. */
  phone: string;
  /** Why the last attempt failed, or a note about the one in progress. */
  message: string | null;
  /** When the prompt now waiting for the PIN was sent (AWAITING_PIN only). */
  promptSentAt: string | null;
  cbsReference: string | null;
  paidAt: string | null;
};

export type PaymentAttemptForSummary = {
  status: string;
  statusDesc: string | null;
  amount: number;
  createdAt: Date | string;
  completedAt: Date | string | null;
  ft: { cbsReference: string } | null;
};

const OPEN = ['PENDING', 'AWAITING_PIN'];

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** `attempts` newest first. */
export function summarizeTelegramPayment(
  order: { status: string; totalAmount: number; borrowerId: string },
  attempts: PaymentAttemptForSummary[],
  options: { enabled: boolean; merchantCanReceive: boolean; now?: Date },
): TelegramOrderPayment {
  const now = options.now ?? new Date();
  const base: TelegramOrderPayment = {
    enabled: options.enabled,
    merchantCanReceive: options.merchantCanReceive,
    state: 'UNPAID',
    canPay: false,
    amount: order.totalAmount,
    phone: maskPhone(order.borrowerId),
    message: null,
    promptSentAt: null,
    cbsReference: null,
    paidAt: null,
  };

  // Any confirmed attempt wins, even an older one settled by a late callback.
  const paid = attempts.find(a => a.status === 'COMPLETED');
  if (paid) {
    return { ...base, state: 'PAID', amount: paid.amount, cbsReference: paid.ft?.cbsReference ?? null, paidAt: iso(paid.completedAt) };
  }
  if (attempts.some(a => a.status === 'PROCESSING')) return { ...base, state: 'PROCESSING' };

  const payable = options.enabled && options.merchantCanReceive && order.status === 'ON_DELIVERY';
  const latest = attempts[0];

  // A prompt the bank has not answered may have been approved, even behind a
  // newer attempt that failed: offering "Pay" again could charge twice.
  const open = attempts.find(a => OPEN.includes(a.status));
  if (open) {
    const ageSeconds = (now.getTime() - new Date(open.createdAt).getTime()) / 1000;
    return {
      ...base,
      state: 'AWAITING_PIN',
      promptSentAt: iso(open.createdAt),
      canPay: payable && ageSeconds >= PAYMENT_RESEND_AFTER_SECONDS,
      // PENDING here means the bank never answered the request.
      message: open.status === 'PENDING' ? "We couldn't confirm the prompt was sent. If it doesn't arrive, send it again in a minute." : null,
    };
  }

  return { ...base, canPay: payable, message: latest?.status === 'FAILED' ? latest.statusDesc || 'The payment was not completed.' : null };
}
