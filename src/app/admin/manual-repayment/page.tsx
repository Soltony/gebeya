'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { useToast } from '@/hooks/use-toast';
import { DEFAULT_POLICY } from '@/lib/manual-repayment';
import {
  canDecideRepayment,
  canEnterRepayment,
  canRequestReversal,
} from '@/lib/manual-repayment-access';
import { PolicyCard } from '@/components/admin/manual-repayment/policy-card';
import { RepaymentEntry } from '@/components/admin/manual-repayment/repayment-entry';
import { RepaymentList } from '@/components/admin/manual-repayment/repayment-list';
import type { Policy } from '@/components/admin/manual-repayment/types';

/**
 * Manual Repayment module (BRD 3.2). The Maker records repayments here; everyone
 * with read access — makers, checkers, auditors — gets the repayment report and,
 * for a System Admin, the policy.
 */
export default function ManualRepaymentPage() {
  useRequirePermission(['manual-repayment', 'repayment-approvals']);

  const { currentUser } = useAuth();
  const { toast } = useToast();

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [canEditPolicy, setCanEditPolicy] = useState(false);
  const [isLoadingPolicy, setIsLoadingPolicy] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  const loadPolicy = useCallback(async () => {
    try {
      const res = await fetch('/api/manual-repayments/config');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load the repayment policy.');
      setPolicy(data.policy);
      setCanEditPolicy(!!data.canEdit);
    } catch (e) {
      // The module still works on defaults if the policy row has not been created.
      setPolicy(DEFAULT_POLICY);
      toast({
        title: 'Using default policy',
        description: String((e as Error)?.message ?? e),
        variant: 'destructive',
      });
    } finally {
      setIsLoadingPolicy(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const canEnter = canEnterRepayment(currentUser);
  const canDecide = canDecideRepayment(currentUser);
  const canReverse = canRequestReversal(currentUser);

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Manual Repayment</h2>
        <p className="text-muted-foreground">
          Record a repayment a customer settled outside the NIBtera Super App. Every entry goes to a
          checker before it reaches the loan.
        </p>
      </div>

      <Tabs defaultValue={canEnter ? 'record' : 'report'}>
        <TabsList>
          {canEnter && <TabsTrigger value="record">Record repayment</TabsTrigger>}
          <TabsTrigger value="report">Repayment report</TabsTrigger>
          <TabsTrigger value="policy">Policy</TabsTrigger>
        </TabsList>

        {canEnter && (
          <TabsContent value="record" className="mt-4">
            {isLoadingPolicy || !policy ? (
              <Loading />
            ) : (
              <RepaymentEntry policy={policy} onSubmitted={() => setRefreshToken((n) => n + 1)} />
            )}
          </TabsContent>
        )}

        <TabsContent value="report" className="mt-4 space-y-4">
          <RepaymentList
            title="Manual repayments"
            description="Every manual repayment by date, payment method, user and status (BRD 3.9)."
            emptyMessage="No manual repayments match these filters."
            currentUserId={currentUser?.id}
            canDecide={canDecide}
            canReverse={canReverse}
            refreshToken={refreshToken}
          />
        </TabsContent>

        <TabsContent value="policy" className="mt-4">
          {isLoadingPolicy || !policy ? (
            <Loading />
          ) : (
            <PolicyCard policy={policy} canEdit={canEditPolicy} onSaved={setPolicy} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
