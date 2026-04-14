// src/services/watcher.ts
// Background service that cleans up stale transactions and notifies users.

import { Bot } from 'grammy';
import { BotContext } from '../types/context.js';
import { cleanupExpiredTransactions } from './transactions.js';
import { formatNGN } from '../utils/helpers.js';

export function startTransactionWatcher(bot: Bot<BotContext>) {
  console.log('⏳ Starting Transaction Expiring Watcher (Every 60s)...');

  setInterval(async () => {
    try {
      const expired = await cleanupExpiredTransactions(15);

      if (expired.length > 0) {
        console.log(`🧹 Cleaned up ${expired.length} expired transactions.`);

        // Notify users
        for (const tx of expired) {
          const amountStr = tx.action === 'DEPOSIT' 
            ? `*${formatNGN(tx.amount_ngn)}*` 
            : `*${tx.amount_usdc} USDC*`;

          const message = 
            `⏳ *Transaction Expired*\n\n` +
            `Your order to fund ${amountStr} has expired because payment was not received within 15 minutes.\n\n` +
            `If you still wish to fund your account, please initiate a new request.`;

          try {
            await bot.api.sendMessage(tx.telegram_id, message, { parse_mode: 'Markdown' });
          } catch (err) {
            console.error(`[watcher] Could not notify user ${tx.telegram_id}:`, (err as any).message);
          }

          // NEW: Auto-delete the bank details message
          if (tx.bot_message_id && tx.chat_id) {
            try {
              console.log(`🧹 Deleting expired message ${tx.bot_message_id} in chat ${tx.chat_id}`);
              await bot.api.deleteMessage(tx.chat_id, tx.bot_message_id);
            } catch (err) {
              console.error(`[watcher] Failed to delete message ${tx.bot_message_id}:`, (err as any).message);
            }
          }
        }
      }
    } catch (err) {
      console.error('[watcher] Run failed:', err);
    }
  }, 60000); // Check every minute
}
