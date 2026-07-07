import { requireServerPermission } from '@/lib/require-permission';
import { getUserFromSession } from '@/lib/user';
import { DisbursementControlClient } from './client';
import { getDisbursementControl } from '@/lib/disbursement-control';

export default async function DisbursementControlPage() {
  await requireServerPermission('settings');

  const user = await getUserFromSession();
  if (!user) return <div>Not authenticated</div>;

  if (user.role !== 'Super Admin') {
    return <div>Forbidden</div>;
  }

  const control = await getDisbursementControl();

  return <DisbursementControlClient initialEnabled={control.enabled} />;
}
