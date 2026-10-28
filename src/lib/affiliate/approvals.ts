/**
 * Hooks the affiliate entity types into the shared maker-checker flow in
 * src/app/api/approvals/route.ts.
 */
import { logger } from '@/lib/logger';
import { applyAffiliateChange, applyProgramChange } from './programs';
import { approvePayoutBatch, rejectPayoutBatch, sendApprovedPayouts } from './payouts';
import { applyPointAdjustment, applyPointsSettingsChange } from './points';

export const AFFILIATE_ENTITY_TYPES = [
  'AffiliateProgram',
  'Affiliate',
  'AffiliatePayoutBatch',
  'AffiliatePointsSettings',
  'AffiliatePointAdjustment',
] as const;

export function isAffiliateEntityType(entityType: string): boolean {
  return (AFFILIATE_ENTITY_TYPES as readonly string[]).includes(entityType);
}

type Change = {
  id: string;
  entityType: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  createdById: string;
};

export async function applyAffiliateApproval(change: Change, context?: { actorId?: string }) {
  switch (change.entityType) {
    case 'AffiliateProgram':
      await applyProgramChange(change, context?.actorId);
      return;
    case 'Affiliate':
      await applyAffiliateChange(change, context?.actorId);
      return;
    case 'AffiliatePayoutBatch': {
      if (!change.entityId) throw new Error('Missing payout batch id');
      const batchId = change.entityId;
      await approvePayoutBatch(batchId, context?.actorId);
      // Send in the background; the approval itself is complete. Anything not
      // sent here (e.g. disbursements switched off) is picked up by the worker.
      void sendApprovedPayouts(batchId).catch((error) =>
        logger.error(`[affiliate] sending approved batch ${batchId} failed: ${String(error)}`)
      );
      return;
    }
    case 'AffiliatePointsSettings':
      await applyPointsSettingsChange(change, context?.actorId);
      return;
    case 'AffiliatePointAdjustment':
      await applyPointAdjustment(change, context?.actorId);
      return;
    default:
      throw new Error(`Unknown affiliate entity type: ${change.entityType}`);
  }
}

/** Undo side effects of a request that a checker rejected. */
export async function handleAffiliateRejection(change: Change) {
  if (change.entityType === 'AffiliatePayoutBatch' && change.entityId) {
    await rejectPayoutBatch(change.entityId);
  }
}
