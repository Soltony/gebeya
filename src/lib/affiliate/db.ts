import { Prisma } from '@prisma/client';

// SQL Server accepts at most 2100 parameters per statement, so long `in` lists
// are split.
export const SQL_IN_CHUNK = 1000;

export function chunk<T>(items: T[], size = SQL_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Hides most digits of a phone number for lists shown to affiliates. */
export function maskPhone(phone: string): string {
  const digits = String(phone ?? '');
  if (digits.length <= 4) return digits;
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
