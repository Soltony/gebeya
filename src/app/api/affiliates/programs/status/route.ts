import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { AffiliateError, pauseProgram } from '@/lib/affiliate/programs';
import { affiliateErrorResponse, createAffiliateChangeRequest, requireAffiliateUser } from '@/lib/affiliate/requests';

const body = z.object({
  programId: z.string().min(1),
  action: z.enum(['PAUSE', 'RESUME']),
});

/**
 * Pausing takes effect immediately (it only reduces spending). Resuming
 * restarts spending, so it goes through approval.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const { programId, action } = body.parse(await req.json());
    if (action === 'PAUSE') {
      await pauseProgram(programId, auth.user.id);
      return NextResponse.json({ success: true });
    }

    const program = await prisma.affiliateProgram.findUnique({ where: { id: programId } });
    if (!program) throw new AffiliateError('Program not found.', 404);
    if (program.status !== 'PAUSED') throw new AffiliateError('Only a paused program can be resumed.', 409);
    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'AffiliateProgram',
      entityId: program.id,
      changeType: 'UPDATE',
      payload: {
        original: { name: program.name, status: 'PAUSED' },
        updated: { name: program.name, status: 'ACTIVE' },
      },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/programs/status');
  }
}
