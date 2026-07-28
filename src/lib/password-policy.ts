// Client-safe mirror of the password policy enforced by `passwordSchema` in
// `@/lib/validators`. That module pulls in `next/server` and `crypto`, so it
// can't be imported from client components — keep the two rule sets in sync.

const COMMON_PASSWORDS = new Set([
  '123456','123456789','qwerty','password','1234567','12345678','12345','111111','123123','password1','1234567890','1234','welcome','letmein','admin','iloveyou'
]);

/**
 * Validate a password against the local policy.
 * Returns `null` when valid, otherwise a user-facing error message.
 * The breach (pwned) check is done separately via /api/utils/pwned-password.
 */
export function validatePasswordClient(pw: string): string | null {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters long.';
  if (!/(?=.*[a-z])/.test(pw)) return 'Password must contain a lowercase letter.';
  if (!/(?=.*[A-Z])/.test(pw)) return 'Password must contain an uppercase letter.';
  if (!/(?=.*\d)/.test(pw)) return 'Password must contain a number.';
  if (!/(?=.*[^A-Za-z0-9])/.test(pw)) return 'Password must contain a symbol.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'Password is too common or compromised.';
  return null;
}

/**
 * Ask the server whether a password appears in a known breach corpus.
 * Never throws — a failed check returns `false` so the user isn't blocked by a
 * network error; the server enforces the same rule on submit.
 */
export async function isPwnedPasswordClient(password: string): Promise<boolean> {
  try {
    const res = await fetch('/api/utils/pwned-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.pwned;
  } catch (err) {
    console.warn('Pwned password check failed', err);
    return false;
  }
}
