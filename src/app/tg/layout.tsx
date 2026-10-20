import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { TelegramProvider } from '@/components/telegram/telegram-provider';
import { getBotUsername } from '@/lib/telegram/config';
import './tg.css';

export const metadata: Metadata = {
  title: 'Gebeya',
  description: 'Shop from verified merchants in Telegram.',
};

/** Telegram Mini App shell. Reading the CSP nonce also keeps these pages dynamic. */
export default async function TelegramLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <TelegramProvider nonce={nonce} botUsername={getBotUsername()}>
      {children}
    </TelegramProvider>
  );
}
