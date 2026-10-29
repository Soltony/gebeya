'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { AffiliatesTab } from './affiliates-tab';
import { CommissionsTab } from './commissions-tab';
import { PayoutsTab } from './payouts-tab';
import { PointsTab } from './points-tab';
import { AccountTab } from './account-tab';
import { ProgramsTab } from './programs-tab';
import { ReferralsTab } from './referrals-tab';
import { ReportsTab } from './reports-tab';
import { useAffiliateOptions, useAffiliatePermissions } from './shared';

export function AffiliatesClient() {
  const { currentUser } = useAuth();
  const { canCreate, canUpdate, canReview } = useAffiliatePermissions(currentUser);
  const { options, reload } = useAffiliateOptions();
  const [tab, setTab] = useState('programs');

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Affiliates</h2>
        <p className="text-muted-foreground">
          Configure affiliate programs, manage affiliates and their referred customers, and pay commissions. Every program, affiliate and
          payout change goes through approval.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="programs">Programs</TabsTrigger>
          <TabsTrigger value="affiliates">Affiliates</TabsTrigger>
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
          <TabsTrigger value="commissions">Commissions</TabsTrigger>
          <TabsTrigger value="payouts">Payouts</TabsTrigger>
          <TabsTrigger value="points">Points</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="programs" className="pt-4">
          <ProgramsTab options={options} canCreate={canCreate} canUpdate={canUpdate} onChanged={reload} />
        </TabsContent>
        <TabsContent value="affiliates" className="pt-4">
          <AffiliatesTab canCreate={canCreate} canUpdate={canUpdate} />
        </TabsContent>
        <TabsContent value="referrals" className="pt-4">
          <ReferralsTab options={options} canUpdate={canUpdate} />
        </TabsContent>
        <TabsContent value="commissions" className="pt-4">
          <CommissionsTab options={options} />
        </TabsContent>
        <TabsContent value="payouts" className="pt-4">
          <PayoutsTab options={options} canUpdate={canUpdate} canReview={canReview} />
        </TabsContent>
        <TabsContent value="points" className="pt-4">
          <PointsTab canUpdate={canUpdate} />
        </TabsContent>
        <TabsContent value="account" className="pt-4">
          <AccountTab canUpdate={canUpdate} canReview={canReview} />
        </TabsContent>
        <TabsContent value="reports" className="pt-4">
          <ReportsTab options={options} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
