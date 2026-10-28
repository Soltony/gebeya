import { requireServerPermission } from '@/lib/require-permission';
import { AffiliatesClient } from '@/components/admin/affiliates/affiliates-client';

export const dynamic = 'force-dynamic';

export default async function AffiliatesPage() {
  await requireServerPermission('affiliates');
  return <AffiliatesClient />;
}
