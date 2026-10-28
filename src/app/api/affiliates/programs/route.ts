import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { describeProgram, readStoredConfig, type DescribeLookups, type ProgramConfig } from '@/lib/affiliate/config';
import { AffiliateError, assertSelfJoinFree, getCurrentProgramVersion, validateProgramConfig } from '@/lib/affiliate/programs';
import { programCreateSchema } from '@/lib/affiliate/schemas';
import {
  affiliateErrorResponse,
  createAffiliateChangeRequest,
  pendingRequests,
  requireAffiliateUser,
} from '@/lib/affiliate/requests';

async function nameLookups(): Promise<DescribeLookups> {
  const [providers, products, merchants, categories] = await Promise.all([
    prisma.loanProvider.findMany({ select: { id: true, name: true } }),
    prisma.loanProduct.findMany({ select: { id: true, name: true } }),
    prisma.merchant.findMany({ select: { id: true, name: true } }),
    prisma.productCategory.findMany({ select: { id: true, name: true } }),
  ]);
  const toMap = (rows: { id: string; name: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.name]));
  return { providers: toMap(providers), products: toMap(products), merchants: toMap(merchants), categories: toMap(categories) };
}

async function assertNameAvailable(name: string, exceptProgramId?: string) {
  const existing = await prisma.affiliateProgram.findUnique({ where: { name }, select: { id: true } });
  if (existing && existing.id !== exceptProgramId) throw new AffiliateError(`A program named "${name}" already exists.`, 409);
  const pendingCreates = await pendingRequests('AffiliateProgram');
  if (pendingCreates.some((p) => p.changeType === 'CREATE' && p.name?.toLowerCase() === name.toLowerCase())) {
    throw new AffiliateError(`A program named "${name}" is already waiting for approval.`, 409);
  }
}

export async function GET() {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const [programs, lookups, pending] = await Promise.all([
      prisma.affiliateProgram.findMany({ orderBy: { createdAt: 'desc' } }),
      nameLookups(),
      pendingRequests('AffiliateProgram'),
    ]);
    const versions = programs.length
      ? await prisma.affiliateProgramVersion.findMany({
          where: { OR: programs.map((p) => ({ programId: p.id, version: p.currentVersion })) },
        })
      : [];
    const versionByProgram = new Map(versions.map((v) => [v.programId, v]));

    const rows = await Promise.all(
      programs.map(async (program) => {
        const version = versionByProgram.get(program.id);
        let config: ProgramConfig | null = null;
        try {
          config = version ? readStoredConfig(version.config) : null;
        } catch {
          config = null;
        }
        const [affiliateCount, referralCount, earned] = await Promise.all([
          prisma.affiliate.count({ where: { programId: program.id } }),
          prisma.affiliateReferral.count({ where: { programVersion: { programId: program.id } } }),
          prisma.affiliateCommission.aggregate({
            where: { kind: 'EARNED', status: { not: 'REVERSED' }, referral: { programVersion: { programId: program.id } } },
            _sum: { amount: true },
          }),
        ]);
        return {
          id: program.id,
          name: program.name,
          description: program.description,
          status: program.status,
          currentVersion: program.currentVersion,
          pausedAt: program.pausedAt,
          createdAt: program.createdAt,
          config,
          summary: config ? describeProgram(config, lookups) : ['The stored settings of this program could not be read.'],
          affiliateCount,
          referralCount,
          earnedTotal: earned._sum.amount ?? 0,
          pendingChange: pending.some((p) => p.entityId === program.id),
        };
      })
    );

    return NextResponse.json({
      programs: rows,
      pendingCreates: pending.filter((p) => p.changeType === 'CREATE').map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/programs');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('create');
  if (auth.response) return auth.response;

  try {
    const body = programCreateSchema.parse(await req.json());
    const config = validateProgramConfig(body.config);
    await assertNameAvailable(body.name);
    await assertSelfJoinFree(config);
    const summary = describeProgram(config, await nameLookups());
    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'AffiliateProgram',
      changeType: 'CREATE',
      payload: { created: { name: body.name, description: body.description ?? null, summary, config } },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/programs');
  }
}

const updateBody = z.object({
  programId: z.string().min(1),
  name: z.string().trim().min(2, 'Name is too short').max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  config: z.unknown(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const body = updateBody.parse(await req.json());
    const { program, version, config: current } = await getCurrentProgramVersion(body.programId);
    const config = validateProgramConfig(body.config);
    if (body.name !== program.name) await assertNameAvailable(body.name, program.id);
    await assertSelfJoinFree(config, program.id);

    const configChanged = JSON.stringify(config) !== JSON.stringify(current);
    const description = body.description ?? null;
    if (!configChanged && body.name === program.name && description === (program.description ?? null)) {
      throw new AffiliateError('Nothing was changed.', 400);
    }

    // Both sides carry the same keys so the approval screen diffs them correctly;
    // settings are only included (and a new version published) when they changed.
    const lookups = await nameLookups();
    const settings = (v: number, c: ProgramConfig) =>
      configChanged ? { version: v, summary: describeProgram(c, lookups), config: c } : {};
    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'AffiliateProgram',
      entityId: program.id,
      changeType: 'UPDATE',
      payload: {
        original: { name: program.name, description: program.description ?? null, ...settings(version.version, current) },
        updated: { name: body.name, description, ...settings(version.version + 1, config) },
      },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'PUT /api/affiliates/programs');
  }
}
