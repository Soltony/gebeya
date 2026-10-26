
'use server';
/**
 * @fileOverview Standalone worker process for running background tasks.
 * This script is intended to be executed by a scheduler (e.g., cron) or run as a long-running service.
 *
 * Usage:
 * To run a one-off task (like NPL check):
 * npm run run:worker -- npl
 *
 * To start the continuous repayment service:
 * npm run run:worker -- repayment-service
 */

import { logger } from './lib/logger';
import { getAsOfDate } from './lib/date-utils';

const REPAYMENT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PROVIDER_DISTRIBUTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INTEREST_ACCRUAL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENALTY_ACCRUAL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NPL_STATUS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CBS_NPL_UPLOAD_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CBS_NPL_RETRY_INTERVAL_MS =
  (Number(process.env.NPL_RETRY_INTERVAL_MINUTES) > 0
    ? Math.floor(Number(process.env.NPL_RETRY_INTERVAL_MINUTES))
    : 5) * 60 * 1000; // 5 minutes
const NIB_PUSH_RECONCILE_INTERVAL_MS =
  (Number(process.env.NIB_PUSH_RECONCILE_INTERVAL_MINUTES) > 0
    ? Math.floor(Number(process.env.NIB_PUSH_RECONCILE_INTERVAL_MINUTES))
    : 5) * 60 * 1000; // 5 minutes

// Settles NIB USSD push payments whose callback never arrived (30 min to 24 h
// old) from the bank's status endpoint, and tells Telegram customers.
async function runNibPushReconcileOnce() {
  const { reconcilePushPaymentsOnce } = await import('./lib/nib-push/push-payments');
  const { notifyTelegramPaymentUpdate } = await import('./lib/telegram/notifications');
  const { scanned, transitions } = await reconcilePushPaymentsOnce();
  for (const transition of transitions) {
    await notifyTelegramPaymentUpdate(transition);
  }
  if (scanned > 0) {
    const counts = transitions.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.to]: (acc[t.to] ?? 0) + 1 }), {});
    logger.info(`NIB push reconciliation finished scanned=${scanned} changed=${transitions.length} ${JSON.stringify(counts)}`);
  }
}

async function runNibPushReconcileServiceLoop() {
  logger.info('NIB push reconciliation service started');
  while (true) {
    try {
      await runNibPushReconcileOnce();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during NIB push reconciliation:`, error);
      logger.error(`Error during NIB push reconciliation: ${String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, NIB_PUSH_RECONCILE_INTERVAL_MS));
  }
}

async function runProviderDistributionServiceLoop() {
  while (true) {
    try {
      logger.info('Starting provider distribution scheduled run');
      const { runProviderDistributionOnce } = await import('./actions/provider-distribution');
      await runProviderDistributionOnce();
      logger.info('Provider distribution scheduled run finished');
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during provider distribution cycle:`, error);
      logger.error(`Error during provider distribution cycle: ${String(error)}`);
    }
    logger.info(`Provider distribution service sleeping for ${Math.round(PROVIDER_DISTRIBUTION_INTERVAL_MS / (60 * 60 * 1000))}h`);
    await new Promise(resolve => setTimeout(resolve, PROVIDER_DISTRIBUTION_INTERVAL_MS));
  }
}

async function runInterestAccrualServiceLoop() {
  logger.info('Interest accrual service started');
  while (true) {
    try {
      const asOfDate = getAsOfDate();
      logger.info(`Interest accrual tick at ${asOfDate.toISOString()}`);
      logger.info('Starting daily interest accrual scheduled run');
      const { runDailyInterestAccrualOnce } = await import('./actions/interest-accrual');
      const result = await runDailyInterestAccrualOnce(asOfDate);
      logger.info(`Daily interest accrual finished processedLoans=${result.processedLoans} totalAccrued=${result.totalAccrued}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during interest accrual cycle:`, error);
      logger.error(`Error during interest accrual cycle: ${String(error)}`);
    }
    logger.info(`Interest accrual service sleeping for ${Math.round(INTEREST_ACCRUAL_INTERVAL_MS / (60 * 60 * 1000))}h`);
    await new Promise(resolve => setTimeout(resolve, INTEREST_ACCRUAL_INTERVAL_MS));
  }
}

async function runPenaltyAccrualServiceLoop() {
  logger.info('Penalty accrual service started');
  while (true) {
    try {
      const asOfDate = getAsOfDate();
      logger.info(`Penalty accrual tick at ${asOfDate.toISOString()}`);
      logger.info('Starting daily penalty accrual scheduled run');
      const { runDailyPenaltyAccrualOnce } = await import('./actions/penalty-accrual');
      const result = await runDailyPenaltyAccrualOnce(asOfDate);
      logger.info(`Daily penalty accrual finished processedLoans=${result.processedLoans} totalAccrued=${result.totalAccrued}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during penalty accrual cycle:`, error);
      logger.error(`Error during penalty accrual cycle: ${String(error)}`);
    }
    logger.info(`Penalty accrual service sleeping for ${Math.round(PENALTY_ACCRUAL_INTERVAL_MS / (60 * 60 * 1000))}h`);
    await new Promise(resolve => setTimeout(resolve, PENALTY_ACCRUAL_INTERVAL_MS));
  }
}

async function runNplStatusServiceLoop() {
  logger.info('NPL status update service started');
  while (true) {
    try {
      logger.info('Starting daily NPL status update scheduled run');
      const { updateNplStatusJob } = await import('./actions/npl');
      const result = await updateNplStatusJob();
      logger.info(`Daily NPL status update finished success=${result.success} updated=${result.updatedCount}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during NPL status update cycle:`, error);
      logger.error(`Error during NPL status update cycle: ${String(error)}`);
    }
    logger.info(`NPL status update service sleeping for ${Math.round(NPL_STATUS_INTERVAL_MS / (60 * 60 * 1000))}h`);
    await new Promise((resolve) => setTimeout(resolve, NPL_STATUS_INTERVAL_MS));
  }
}

async function runCbsNplUploadServiceLoop() {
  logger.info('CBS NPL upload service started');
  while (true) {
    try {
      // Flag newly overdue borrowers first so the upload always pushes a fresh list.
      try {
        const { updateNplStatusJob } = await import('./actions/npl');
        const nplResult = await updateNplStatusJob();
        logger.info(`Pre-upload NPL status update finished success=${nplResult.success} updated=${nplResult.updatedCount}`);
      } catch (error) {
        logger.error(`Pre-upload NPL status update failed: ${String(error)}`);
      }
      logger.info('Starting daily CBS NPL bulk upload scheduled run');
      const { uploadNplListToCbs } = await import('./actions/cbs-npl');
      const result = await uploadNplListToCbs({ source: 'SCHEDULED' });
      logger.info(
        `Daily CBS NPL upload finished success=${result.success} batch=${result.batchId} sent=${result.accountsSentCount} inserted=${result.insertedCount ?? 'n/a'} existing=${result.alreadyExistsCount ?? 'n/a'}`,
      );
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during CBS NPL upload cycle:`, error);
      logger.error(`Error during CBS NPL upload cycle: ${String(error)}`);
    }
    logger.info(`CBS NPL upload service sleeping for ${Math.round(CBS_NPL_UPLOAD_INTERVAL_MS / (60 * 60 * 1000))}h`);
    await new Promise((resolve) => setTimeout(resolve, CBS_NPL_UPLOAD_INTERVAL_MS));
  }
}

async function runCbsNplRetryServiceLoop() {
  logger.info('CBS NPL retry service started');
  while (true) {
    try {
      const { retryFailedCreditNotificationsOnce } = await import('./actions/cbs-npl');
      const result = await retryFailedCreditNotificationsOnce();
      if (result.eligible > 0) {
        logger.info(
          `CBS NPL retry sweep finished scanned=${result.scanned} eligible=${result.eligible} retried=${result.retried} collected=${result.collected} stillFailing=${result.stillFailing}`,
        );
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during CBS NPL retry cycle:`, error);
      logger.error(`Error during CBS NPL retry cycle: ${String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, CBS_NPL_RETRY_INTERVAL_MS));
  }
}

// Long-polls Telegram for bot updates. Only for TELEGRAM_UPDATE_MODE=polling,
// i.e. hosts Telegram cannot reach with a webhook. Run a single instance:
// Telegram rejects concurrent getUpdates calls for the same bot.
async function runTelegramBotPollingLoop() {
  const { getUpdateMode } = await import('./lib/telegram/config');
  const { callTelegram, ALLOWED_UPDATES, TelegramApiError } = await import('./lib/telegram/bot-api');
  const { handleTelegramUpdate } = await import('./lib/telegram/bot');
  type Update = import('./lib/telegram/bot-api').TelegramUpdate;

  if (getUpdateMode() !== 'polling') {
    throw new Error('telegram-bot polling requires TELEGRAM_UPDATE_MODE=polling (webhook mode uses /api/telegram/webhook).');
  }

  // getUpdates is refused while a webhook is registered.
  await callTelegram('deleteWebhook', { drop_pending_updates: false });
  logger.info('Telegram bot polling started');

  let offset = 0;
  while (true) {
    try {
      const updates = await callTelegram<Update[]>(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ALLOWED_UPDATES },
        { timeoutMs: 45_000 },
      );
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleTelegramUpdate(update);
        } catch (error) {
          logger.error(`Telegram update ${update.update_id} failed: ${String(error)}`);
        }
      }
    } catch (error) {
      const waitSeconds = error instanceof TelegramApiError && error.retryAfterSeconds ? error.retryAfterSeconds : 5;
      logger.error(`Telegram getUpdates failed, retrying in ${waitSeconds}s: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}


async function main() {
  const task = process.argv[2];

  if (!task) {
    console.error('Error: No task specified.');
    process.exit(1);
  }

  // start task log removed to reduce console noise
  logger.info(`Worker started task=${task}`);

  try {
    switch (task) {
      case 'provider-distribution-service':
        logger.info('Starting provider-distribution-service long-running loop');
        await runProviderDistributionServiceLoop();
        break;
      case 'provider-distribution':
        logger.info('Running one-off provider-distribution');
        {
          const { runProviderDistributionOnce } = await import('./actions/provider-distribution');
          await runProviderDistributionOnce();
        }
        logger.info('One-off provider-distribution finished');
        process.exit(0);
        break;
      case 'interest-accrual-service':
        logger.info('Starting interest-accrual-service long-running loop');
        await runInterestAccrualServiceLoop();
        break;
      case 'interest-accrual':
        logger.info('Running one-off interest-accrual');
        {
          const { runDailyInterestAccrualOnce } = await import('./actions/interest-accrual');
          await runDailyInterestAccrualOnce(new Date());
        }
        logger.info('One-off interest-accrual finished');
        process.exit(0);
        break;
      case 'penalty-accrual-service':
        logger.info('Starting penalty-accrual-service long-running loop');
        await runPenaltyAccrualServiceLoop();
        break;
      case 'penalty-accrual':
        logger.info('Running one-off penalty-accrual');
        {
          const { runDailyPenaltyAccrualOnce } = await import('./actions/penalty-accrual');
          await runDailyPenaltyAccrualOnce(new Date());
        }
        logger.info('One-off penalty-accrual finished');
        process.exit(0);
        break;
      case 'npl':
        // This is a one-off task.
        {
          const { updateNplStatusJob } = await import('./actions/npl');
          await updateNplStatusJob();
        }
        process.exit(0);
        break;
      case 'npl-service':
        logger.info('Starting npl-service long-running loop');
        await runNplStatusServiceLoop();
        break;
      case 'cbs-npl-upload':
        logger.info('Running one-off cbs-npl-upload');
        {
          const { uploadNplListToCbs } = await import('./actions/cbs-npl');
          const result = await uploadNplListToCbs({ source: 'SCHEDULED' });
          logger.info(
            `One-off CBS NPL upload finished success=${result.success} batch=${result.batchId} sent=${result.accountsSentCount}`,
          );
        }
        process.exit(0);
        break;
      case 'cbs-npl-upload-service':
        logger.info('Starting cbs-npl-upload-service long-running loop');
        await runCbsNplUploadServiceLoop();
        break;
      case 'cbs-npl-retry':
        logger.info('Running one-off cbs-npl-retry sweep');
        {
          const { retryFailedCreditNotificationsOnce } = await import('./actions/cbs-npl');
          const result = await retryFailedCreditNotificationsOnce();
          logger.info(
            `One-off CBS NPL retry sweep finished scanned=${result.scanned} eligible=${result.eligible} retried=${result.retried} collected=${result.collected} stillFailing=${result.stillFailing}`,
          );
        }
        process.exit(0);
        break;
      case 'cbs-npl-retry-service':
        logger.info('Starting cbs-npl-retry-service long-running loop');
        await runCbsNplRetryServiceLoop();
        break;
      case 'telegram-bot':
        logger.info('Starting telegram-bot polling loop');
        await runTelegramBotPollingLoop();
        break;
      case 'nib-push-reconcile':
        logger.info('Running one-off nib-push-reconcile');
        await runNibPushReconcileOnce();
        process.exit(0);
        break;
      case 'nib-push-reconcile-service':
        logger.info('Starting nib-push-reconcile-service long-running loop');
        await runNibPushReconcileServiceLoop();
        break;
      default:
        console.error(`Error: Unknown task "${task}".`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error executing task "${task}":`, error);
    process.exit(1);
  }
}

main();
