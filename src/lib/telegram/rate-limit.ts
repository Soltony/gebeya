/**
 * Fixed-window counter per key, held in process memory. Enough to stop a
 * double-tapped button or a scripted client from flooding merchants with
 * orders on a single instance; not a distributed limit.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export function takeRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
