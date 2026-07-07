export interface DiscountLike {
  type?: string | null;
  value?: number | null;
  status?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

function toValidDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeDiscountStartDate(value: Date | string | null | undefined) {
  const date = toValidDate(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function normalizeDiscountEndDate(value: Date | string | null | undefined) {
  const date = toValidDate(value);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

export function isDiscountActive(rule: DiscountLike, now = new Date()) {
  if (rule.status && String(rule.status).toUpperCase() !== 'ACTIVE') return false;

  const startDate = normalizeDiscountStartDate(rule.startDate);
  if (startDate && startDate.getTime() > now.getTime()) return false;

  const endDate = normalizeDiscountEndDate(rule.endDate);
  if (endDate && endDate.getTime() < now.getTime()) return false;

  return true;
}

export function getDiscountEffectiveAmount(baseAmount: number, rule: DiscountLike) {
  const type = String(rule.type || '').toUpperCase();
  const value = Number(rule.value || 0);

  if (!Number.isFinite(value) || value <= 0) return 0;
  if (type === 'PERCENTAGE' || type === 'PERCENT') return (baseAmount * value) / 100;
  if (type === 'FIXED') return value;

  return 0;
}

export function pickBestDiscount<T extends DiscountLike>(baseAmount: number, discounts: T[]) {
  let best: T | null = null;
  let bestAmount = 0;

  for (const discount of discounts) {
    const effectiveAmount = getDiscountEffectiveAmount(baseAmount, discount);
    if (effectiveAmount > bestAmount) {
      best = discount;
      bestAmount = effectiveAmount;
    }
  }

  return best;
}