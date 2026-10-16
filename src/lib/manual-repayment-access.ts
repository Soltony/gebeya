/**
 * Who may do what in the manual repayment module.
 *
 * The module keys match the `permissionKey` on the sidebar entries in
 * `menu-items.ts`. They are spelled out here once because the page guards, the
 * middleware and the API routes all have to agree on the same two strings.
 *
 *   Maker (Repayment Officer)  manual-repayment: create
 *   Checker (Digital Ops)      repayment-approvals: update
 *   Auditor                    either key: read
 *   System Admin               access-control: update (policy)
 */

import type { User } from './types';

export const MAKER_MODULE = 'manual-repayment';
export const CHECKER_MODULE = 'repayment-approvals';

type Actor = Pick<User, 'permissions' | 'role'> | null | undefined;

const can = (
  user: Actor,
  moduleKey: string,
  action: 'create' | 'read' | 'update' | 'delete' | 'approve',
) => !!user?.permissions?.[moduleKey]?.[action];

/** May key in a new repayment. */
export const canEnterRepayment = (user: Actor) => can(user, MAKER_MODULE, 'create');

/** May see repayments and the module's reports — makers, checkers and auditors. */
export const canViewRepayments = (user: Actor) =>
  can(user, MAKER_MODULE, 'read') || can(user, CHECKER_MODULE, 'read');

/** May approve or reject a repayment someone else entered. */
export const canDecideRepayment = (user: Actor) =>
  can(user, CHECKER_MODULE, 'update') || can(user, CHECKER_MODULE, 'approve');

/** May ask for a posted repayment to be backed out. */
export const canRequestReversal = (user: Actor) =>
  can(user, MAKER_MODULE, 'update') || can(user, MAKER_MODULE, 'delete');

/** May change the module's policy (limits, receipts, notifications). */
export const canConfigureModule = (user: Actor) =>
  user?.role === 'Super Admin' || can(user, 'access-control', 'update');

/** The IP and user agent the audit trail records for every transition. */
export function requestActorContext(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for');
  return {
    ipAddress:
      (forwarded ? forwarded.split(',')[0].trim() : null) || req.headers.get('x-real-ip') || 'N/A',
    userAgent: req.headers.get('user-agent') || 'N/A',
  };
}
