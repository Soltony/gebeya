/**
 * Registers the Gebeya bot's commands, chat menu button and update delivery
 * with Telegram. Re-run whenever TELEGRAM_* settings change. Reads .env.
 *
 *   npx tsx -r tsconfig-paths/register scripts/telegram-setup.ts           # apply settings
 *   npx tsx -r tsconfig-paths/register scripts/telegram-setup.ts --info    # show current state only
 *
 * In webhook mode it points Telegram at TELEGRAM_WEBHOOK_URL with
 * TELEGRAM_WEBHOOK_SECRET; in polling mode it removes any webhook so the
 * worker (`npm run run:worker -- telegram-bot`) can call getUpdates.
 */
import 'dotenv/config';
import { ALLOWED_UPDATES, callTelegram } from '@/lib/telegram/bot-api';
import { getMiniAppUrl, getUpdateMode, getWebhookSecret, getWebhookUrl } from '@/lib/telegram/config';
import { BRAND_NAME } from '@/lib/telegram/messages';

const COMMANDS = [
  { command: 'shop', description: 'Browse products' },
  { command: 'orders', description: 'Your recent orders' },
  { command: 'phone', description: 'Link your phone number' },
  { command: 'help', description: 'How this bot works' },
];

async function printInfo() {
  const me = await callTelegram<{ id: number; username: string }>('getMe');
  const webhook = await callTelegram<Record<string, unknown>>('getWebhookInfo');
  const menu = await callTelegram<Record<string, unknown>>('getChatMenuButton');
  console.log(JSON.stringify({ bot: `@${me.username} (${me.id})`, webhook, menuButton: menu }, null, 2));
}

async function main() {
  if (process.argv.includes('--info')) {
    await printInfo();
    return;
  }

  const mode = getUpdateMode();
  const miniAppUrl = getMiniAppUrl();
  if (!miniAppUrl.startsWith('https://')) {
    throw new Error('TELEGRAM_MINIAPP_URL must be an https:// URL; Telegram will not open Mini Apps over http.');
  }

  await callTelegram('setMyCommands', { commands: COMMANDS });
  await callTelegram('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Shop', web_app: { url: miniAppUrl } },
  });
  await callTelegram('setMyShortDescription', {
    short_description: `Shop from verified merchants with ${BRAND_NAME}.`,
  });

  if (mode === 'webhook') {
    await callTelegram('setWebhook', {
      url: getWebhookUrl(),
      secret_token: getWebhookSecret(),
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 20,
    });
    console.log('Webhook registered.');
  } else {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook removed. Start polling with: npm run run:worker -- telegram-bot');
  }

  await printInfo();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
