'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { canDecideRepayment, canRequestReversal } from '@/lib/manual-repayment-access';
import { RepaymentList } from '@/components/admin/manual-repayment/repayment-list';

/**
 * The Checker's queue (BRD 3.6). Approving posts the repayment; rejecting needs a
 * reason. A checker can never decide on an entry they recorded themselves — the
 * server refuses it and the dialog hides the buttons.
 */
export default function ManualRepaymentApprovalsPage() {
  useRequirePermission(['repayment-approvals']);

  const { currentUser } = useAuth();
  const [refreshToken, setRefreshToken] = useState(0);

  const canDecide = canDecideRepayment(currentUser);
  const canReverse = canRequestReversal(currentUser);

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Repayment Approvals</h2>
        <p className="text-muted-foreground">
          Review manual repayments recorded by branch users, then approve to post them against the loan or
          reject them with a reason.
        </p>
      </div>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Awaiting decision</TabsTrigger>
          <TabsTrigger value="decided">Decided</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4 space-y-4">
          <RepaymentList
            title="Pending approval"
            description="Repayments waiting on a checker, and posted repayments waiting on a reversal decision."
            fixedStatuses={['PENDING_APPROVAL', 'PENDING_REVERSAL']}
            emptyMessage="Nothing is waiting for a decision."
            currentUserId={currentUser?.id}
            canDecide={canDecide}
            canReverse={canReverse}
            refreshToken={refreshToken}
            onChanged={() => setRefreshToken((n) => n + 1)}
          />
        </TabsContent>

        <TabsContent value="decided" className="mt-4 space-y-4">
          <RepaymentList
            title="Posted, rejected and reversed"
            description="Everything already decided, for reconciliation against core banking (BRD 3.9)."
            fixedStatuses={['APPROVED', 'REJECTED', 'REVERSED']}
            emptyMessage="No decided repayments match these filters."
            currentUserId={currentUser?.id}
            canDecide={canDecide}
            canReverse={canReverse}
            refreshToken={refreshToken}
            onChanged={() => setRefreshToken((n) => n + 1)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
