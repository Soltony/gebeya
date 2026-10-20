import { OrderScreen } from '@/components/telegram/order-screen';

export default async function TelegramOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const [{ id }, { placed }] = await Promise.all([params, searchParams]);
  return <OrderScreen orderId={id} justPlaced={placed === '1'} />;
}
