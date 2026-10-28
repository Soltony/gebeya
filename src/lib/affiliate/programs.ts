/**
 * Affiliate programs and affiliates: loading program versions, and applying
 * changes once a checker approves them (programs and affiliates are only ever
 * created or edited through maker-checker).
 */
import { randomInt } from 'crypto';
import type { z } from 'zod';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import {
  AFFILIATE_TYPES,
  AFFILIATE_TYPE_LABELS,
  REFERRAL_CODE_PATTERN,
  normalizeReferralCode,
  parseProgramConfig,
  readStoredConfig,
  type ProgramConfig,
} from './config';
import { parsePausedPeriods, type PauseWindow } from './engine';
import { affiliateCreateSchema, affiliateUpdateSchema, programCreateSchema, programUpdateSchema } from './schemas';

export class AffiliateError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ProgramRuntime = {
  id: string;
  name: string;
  status: string;
  pausedAt: Date | null;
  pausedPeriods: PauseWindow[];
  currentVersion: number;
  currentVersionId: string | null;
  /** Null when the stored config can't be read; the program is then skipped. */
  currentConfig: ProgramConfig | null;
};

export async function loadProgramRuntimes(): Promise<Map<string, ProgramRuntime>> {
  const programs = await prisma.affiliateProgram.findMany();
  const runtimes = new Map<string, ProgramRuntime>();
  if (!programs.length) return runtimes;
  const versions = await prisma.affiliateProgramVersion.findMany({
    where: { OR: programs.map((p) => ({ programId: p.id, version: p.currentVersion })) },
  });
  const versionByProgram = new Map(versions.map((v) => [v.programId, v]));
  for (const program of programs) {
    const version = versionByProgram.get(program.id);
    let currentConfig: ProgramConfig | null = null;
    try {
      currentConfig = version ? readStoredConfig(version.config) : null;
    } catch {
      currentConfig = null;
    }
    runtimes.set(program.id, {
      id: program.id,
      name: program.name,
      status: program.status,
      pausedAt: program.pausedAt,
      pausedPeriods: parsePausedPeriods(program.pausedPeriods),
      currentVersion: program.currentVersion,
      currentVersionId: version?.id ?? null,
      currentConfig,
    });
  }
  return runtimes;
}

export async function getCurrentProgramVersion(programId: string) {
  const program = await prisma.affiliateProgram.findUnique({ where: { id: programId } });
  if (!program) throw new AffiliateError('Program not found.', 404);
  const version = await prisma.affiliateProgramVersion.findUnique({
    where: { programId_version: { programId, version: program.currentVersion } },
  });
  if (!version) throw new AffiliateError('Program has no published version.', 500);
  return { program, version, config: readStoredConfig(version.config) };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

export function generateCode(length = 7): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

async function uniqueAffiliateCode(requested?: string | null): Promise<string> {
  if (requested) {
    const code = normalizeReferralCode(requested);
    if (!REFERRAL_CODE_PATTERN.test(code)) {
      throw new AffiliateError('Codes must be 4 to 16 letters or digits.');
    }
    const taken = await prisma.affiliate.findUnique({ where: { code }, select: { id: true } });
    if (taken) throw new AffiliateError(`The code ${code} is already used by another affiliate.`, 409);
    return code;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateCode();
    const taken = await prisma.affiliate.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new AffiliateError('Could not generate a unique code, please try again.', 500);
}

function parseOrThrow<T>(schema: z.ZodType<T, any, any>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AffiliateError(result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}

export function validateProgramConfig(config: unknown): ProgramConfig {
  const parsed = parseProgramConfig(config);
  if (!parsed.success) throw new AffiliateError(parsed.errors.join('\n'));
  return parsed.config;
}

/**
 * Only one program at a time may let customers get their own code, so the
 * Earn page always knows which program a customer joins. Paused programs count
 * too, otherwise resuming one would create a second.
 */
export async function assertSelfJoinFree(config: ProgramConfig, exceptProgramId?: string) {
  if (!config.selfJoin.enabled) return;
  const runtimes = await loadProgramRuntimes();
  for (const runtime of runtimes.values()) {
    if (runtime.id !== exceptProgramId && runtime.currentConfig?.selfJoin.enabled) {
      throw new AffiliateError(
        `Customers can already get their own code in "${runtime.name}". Only one program can do this at a time; turn it off there first.`,
        409
      );
    }
  }
}

async function assertProgramNameFree(name: string, exceptId?: string) {
  const existing = await prisma.affiliateProgram.findUnique({ where: { name }, select: { id: true } });
  if (existing && existing.id !== exceptId) throw new AffiliateError(`A program named "${name}" already exists.`, 409);
}

export async function assertAffiliateTypeAllowed(programId: string, type: string) {
  const { program, config } = await getCurrentProgramVersion(programId);
  if (!config.allowedAffiliateTypes.includes(type as (typeof AFFILIATE_TYPES)[number])) {
    const label = AFFILIATE_TYPE_LABELS[type as (typeof AFFILIATE_TYPES)[number]] ?? type;
    throw new AffiliateError(`"${program.name}" does not accept ${label} affiliates.`);
  }
}

// ---------------------------------------------------------------------------
// Applying approved changes
// ---------------------------------------------------------------------------

type ApprovedChange = {
  id: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  createdById: string;
};

export async function applyProgramChange(change: ApprovedChange, actorId?: string) {
  const data = JSON.parse(change.payload);

  if (change.changeType === 'CREATE') {
    const payload = parseOrThrow(programCreateSchema, data.created);
    const config = validateProgramConfig(payload.config);
    await assertProgramNameFree(payload.name);
    await assertSelfJoinFree(config);
    const program = await prisma.$transaction(async (tx) => {
      const created = await tx.affiliateProgram.create({
        data: { name: payload.name, description: payload.description ?? null, status: 'ACTIVE', currentVersion: 1 },
      });
      await tx.affiliateProgramVersion.create({
        data: { programId: created.id, version: 1, config: JSON.stringify(config), publishedById: change.createdById },
      });
      return created;
    });
    await createAuditLog({
      actorId: actorId ?? 'system',
      action: 'AFFILIATE_PROGRAM_CREATED',
      entity: 'AffiliateProgram',
      entityId: program.id,
      details: { changeId: change.id, name: program.name },
    });
    return;
  }

  if (change.changeType === 'UPDATE') {
    if (!change.entityId) throw new AffiliateError('Missing program id.');
    const payload = parseOrThrow(programUpdateSchema, data.updated);
    const program = await prisma.affiliateProgram.findUnique({ where: { id: change.entityId } });
    if (!program) throw new AffiliateError('Program not found.', 404);
    if (payload.name && payload.name !== program.name) await assertProgramNameFree(payload.name, program.id);
    const config = payload.config !== undefined ? validateProgramConfig(payload.config) : null;
    if (config) await assertSelfJoinFree(config, program.id);

    const now = new Date();
    let newVersion = program.currentVersion;
    await prisma.$transaction(async (tx) => {
      const update: Record<string, unknown> = {};
      if (payload.name) update.name = payload.name;
      if (payload.description !== undefined) update.description = payload.description ?? null;
      if (config) {
        newVersion = program.currentVersion + 1;
        await tx.affiliateProgramVersion.create({
          data: { programId: program.id, version: newVersion, config: JSON.stringify(config), publishedById: change.createdById },
        });
        update.currentVersion = newVersion;
      }
      // Resuming closes the pause window; events inside it never earn.
      if (payload.status === 'ACTIVE' && program.status === 'PAUSED') {
        const periods = parsePausedPeriods(program.pausedPeriods);
        if (program.pausedAt) periods.push({ from: program.pausedAt, to: now });
        update.pausedPeriods = JSON.stringify(periods.map((p) => ({ from: p.from.toISOString(), to: p.to.toISOString() })));
        update.pausedAt = null;
        update.status = 'ACTIVE';
      }
      if (Object.keys(update).length) {
        await tx.affiliateProgram.update({ where: { id: program.id }, data: update });
      }
    });
    await createAuditLog({
      actorId: actorId ?? 'system',
      action: 'AFFILIATE_PROGRAM_UPDATED',
      entity: 'AffiliateProgram',
      entityId: program.id,
      details: { changeId: change.id, version: newVersion, resumed: payload.status === 'ACTIVE' },
    });
    return;
  }

  throw new AffiliateError(`Unsupported change type ${change.changeType} for an affiliate program.`);
}

export async function applyAffiliateChange(change: ApprovedChange, actorId?: string) {
  const data = JSON.parse(change.payload);

  if (change.changeType === 'CREATE') {
    const payload = parseOrThrow(affiliateCreateSchema, data.created);
    await assertAffiliateTypeAllowed(payload.programId, payload.type);
    const existing = await prisma.affiliate.findUnique({ where: { phoneNumber: payload.phoneNumber }, select: { id: true } });
    if (existing) throw new AffiliateError('This phone number is already registered as an affiliate.', 409);
    const code = await uniqueAffiliateCode(payload.code);
    const affiliate = await prisma.affiliate.create({
      data: {
        code,
        type: payload.type,
        name: payload.name,
        phoneNumber: payload.phoneNumber,
        email: payload.email ?? null,
        payoutAccount: payload.payoutAccount ?? null,
        programId: payload.programId,
        status: 'ACTIVE',
      },
    });
    await createAuditLog({
      actorId: actorId ?? 'system',
      action: 'AFFILIATE_CREATED',
      entity: 'Affiliate',
      entityId: affiliate.id,
      details: { changeId: change.id, code, programId: payload.programId },
    });
    return;
  }

  if (change.changeType === 'UPDATE') {
    if (!change.entityId) throw new AffiliateError('Missing affiliate id.');
    const payload = parseOrThrow(affiliateUpdateSchema, data.updated);
    const affiliate = await prisma.affiliate.findUnique({ where: { id: change.entityId } });
    if (!affiliate) throw new AffiliateError('Affiliate not found.', 404);
    const programId = payload.programId ?? affiliate.programId;
    const type = payload.type ?? affiliate.type;
    if (payload.programId || payload.type) await assertAffiliateTypeAllowed(programId, type);
    const payoutAccount = payload.payoutAccount !== undefined ? payload.payoutAccount : affiliate.payoutAccount;
    if (type !== 'BORROWER' && !payoutAccount) {
      throw new AffiliateError('A payout account is required (only borrowers can be paid into their linked account).');
    }

    const update: Record<string, unknown> = {};
    if (payload.name) update.name = payload.name;
    if (payload.type) update.type = payload.type;
    if (payload.programId) update.programId = payload.programId;
    if (payload.email !== undefined) update.email = payload.email ?? null;
    if (payload.payoutAccount !== undefined) update.payoutAccount = payload.payoutAccount ?? null;
    if (payload.status === 'ACTIVE') {
      update.status = 'ACTIVE';
      update.suspendedReason = null;
      update.suspendedAt = null;
    }
    await prisma.affiliate.update({ where: { id: affiliate.id }, data: update });
    await createAuditLog({
      actorId: actorId ?? 'system',
      action: payload.status === 'ACTIVE' ? 'AFFILIATE_REACTIVATED' : 'AFFILIATE_UPDATED',
      entity: 'Affiliate',
      entityId: affiliate.id,
      details: { changeId: change.id, fields: Object.keys(update) },
    });
    return;
  }

  throw new AffiliateError(`Unsupported change type ${change.changeType} for an affiliate.`);
}

// ---------------------------------------------------------------------------
// Immediate, risk-reducing actions (no approval needed; always audited)
// ---------------------------------------------------------------------------

export async function pauseProgram(programId: string, actorId: string) {
  const res = await prisma.affiliateProgram.updateMany({
    where: { id: programId, status: 'ACTIVE' },
    data: { status: 'PAUSED', pausedAt: new Date() },
  });
  if (res.count === 0) throw new AffiliateError('Only an active program can be paused.', 409);
  await createAuditLog({ actorId, action: 'AFFILIATE_PROGRAM_PAUSED', entity: 'AffiliateProgram', entityId: programId });
}

export async function suspendAffiliate(affiliateId: string, reason: string, actorId: string) {
  const res = await prisma.affiliate.updateMany({
    where: { id: affiliateId, status: 'ACTIVE' },
    data: { status: 'SUSPENDED', suspendedReason: reason, suspendedAt: new Date() },
  });
  if (res.count === 0) throw new AffiliateError('Only an active affiliate can be suspended.', 409);
  await createAuditLog({
    actorId,
    action: 'AFFILIATE_SUSPENDED',
    entity: 'Affiliate',
    entityId: affiliateId,
    details: { reason },
  });
}
