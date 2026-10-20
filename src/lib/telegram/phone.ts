/**
 * Borrower ids are Ethiopian mobile numbers in 251XXXXXXXXX form (the format
 * the super-app token validation returns). Telegram contacts arrive as
 * "+2519...", "2519..." or occasionally a local "09..." number.
 */
export function normalizeEthiopianPhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  let national: string;
  if (digits.length === 12 && digits.startsWith('251')) national = digits.slice(3);
  else if (digits.length === 10 && digits.startsWith('0')) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return null;

  // Mobile numbers: 9XXXXXXXX (Ethio Telecom) and 7XXXXXXXX (Safaricom).
  if (!/^[79]\d{8}$/.test(national)) return null;
  return `251${national}`;
}

/** 2519****6017 — enough for the user to recognise their number. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
