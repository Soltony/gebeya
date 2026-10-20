import { ItemScreen } from '@/components/telegram/item-screen';

export default async function TelegramItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemScreen itemId={id} />;
}
