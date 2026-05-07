// src/services/watcher.ts
// Background service that cleans up stale transactions and notifies users.

import { Bot } from 'grammy';
import { BotContext } from '../types/context.js';
import { cleanupExpiredTransactions } from './transactions.js';
import { formatNGN } from '../utils/helpers.js';

import { getAllWallets } from './wallet.js';
import { getSolBalance, getUsdcBalance } from './solana.js';
import { getClusterForAction } from '../config/networks.js';
import { syncPrivateCredits } from './umbra.js';
import { processStealthReceivals } from './stealth.js';
import fs from 'fs';
import path from 'path';

const BALANCES_FILE = path.join(process.cwd(), 'last_balances.json');

function loadLastBalances(): Record<string, { sol: number; usdc: number }> {
  try {
    if (fs.existsSync(BALANCES_FILE)) {
      return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[watcher] Failed to load balances cache:', err);
  }
  return {};
}

function saveLastBalances(data: Record<string, { sol: number; usdc: number }>) {
  try {
    fs.writeFileSync(BALANCES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[watcher] Failed to save balances cache:', err);
  }
}

export function startTransactionWatcher(bot: Bot<BotContext>) {
  console.log('⏳ Starting background watchers...');
  
  // 1. Transaction Expiry Watcher (Every 60s)
  setInterval(async () => {
    try {
      const expired = await cleanupExpiredTransactions(15);
      if (expired.length > 0) {
        console.log(`🧹 Cleaned up ${expired.length} expired transactions.`);
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

          if (tx.bot_message_id && tx.chat_id) {
            try {
              await bot.api.deleteMessage(tx.chat_id, tx.bot_message_id);
            } catch (err) { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.error('[watcher:expiry] Run failed:', err);
    }
  }, 60000);

  // 2. Credit Alert Watcher (Every 45s)
  let lastBalances = loadLastBalances();
  let stabilityCounters: Record<string, { sol: number; usdc: number; count: number }> = {};

  setInterval(async () => {
    try {
      const wallets = await getAllWallets();
      const cluster = getClusterForAction('BUY_USDC');
      
      for (const wallet of wallets) {
        try {
          const [sol, usdc] = await Promise.all([
            getSolBalance(wallet.solana_public_key, cluster).catch(() => null),
            getUsdcBalance(wallet.solana_public_key, cluster).catch(() => null)
          ]);

          if (sol === null || usdc === null) continue;

          // RPC Lag Protection: If balance is exactly 0 but was much higher before, 
          // ignore it once to see if it's just a temporary RPC glitch.
          const last = lastBalances[wallet.telegram_id];
          if (last && (usdc === 0 && last.usdc > 0) || (sol === 0 && last.sol > 0.01)) {
             console.warn(`[watcher:credit] Potential RPC lag detected for ${wallet.telegram_id}. Skipping 0-balance update.`);
             continue; 
          }

          if (last) {
            // Check USDC Credit with Stability (Must see the same increase twice to alert)
            if (usdc > last.usdc) {
              const stable = stabilityCounters[wallet.telegram_id];
              if (stable && stable.usdc === usdc) {
                stable.count++;
                if (stable.count >= 2) {
                  const diff = (usdc - last.usdc).toFixed(4);
                  console.log(`[watcher:credit] Confirmed USDC credit for ${wallet.telegram_id}: +${diff}`);
                  await bot.api.sendMessage(wallet.telegram_id, 
                    `💰 *Credit Alert (USDC)*\n\n` +
                    `You have received *${diff} USDC* in your wallet.\n\n` +
                    `💳 *Current Balance:* ${usdc.toFixed(4)} USDC\n` +
                    `🔗 [View on Solscan](https://solscan.io/account/${wallet.solana_public_key})`,
                    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
                  ).catch(() => null);
                  
                  // Update primary cache and reset stability
                  lastBalances[wallet.telegram_id] = { sol, usdc };
                  delete stabilityCounters[wallet.telegram_id];
                }
              } else {
                // First time seeing this increase, start stability check
                stabilityCounters[wallet.telegram_id] = { sol, usdc, count: 1 };
                continue; // Wait for next interval to confirm
              }
            } else if (usdc < last.usdc) {
              // Balance went down (spend), update cache silently
              lastBalances[wallet.telegram_id].usdc = usdc;
              delete stabilityCounters[wallet.telegram_id];
            }

            // Check SOL Credit with Stability
            if (sol > last.sol + 0.0001) {
              const stable = stabilityCounters[wallet.telegram_id];
              if (stable && stable.sol === sol) {
                stable.count++;
                if (stable.count >= 2) {
                  const diff = (sol - last.sol).toFixed(6);
                  console.log(`[watcher:credit] Confirmed SOL credit for ${wallet.telegram_id}: +${diff}`);
                  await bot.api.sendMessage(wallet.telegram_id, 
                    `◎ *Credit Alert (SOL)*\n\n` +
                    `You have received *${diff} SOL* in your wallet.\n\n` +
                    `💳 *Current Balance:* ${sol.toFixed(6)} SOL`,
                    { parse_mode: 'Markdown' }
                  ).catch(() => null);

                  lastBalances[wallet.telegram_id].sol = sol;
                  delete stabilityCounters[wallet.telegram_id];
                }
              } else {
                stabilityCounters[wallet.telegram_id] = { sol, usdc, count: 1 };
                continue;
              }
            } else if (sol < last.sol) {
              lastBalances[wallet.telegram_id].sol = sol;
              delete stabilityCounters[wallet.telegram_id];
            }
          } else {
            // First time seeing this wallet, initialize cache
            lastBalances[wallet.telegram_id] = { sol, usdc };
          }

          // Persist progress frequently
          saveLastBalances(lastBalances);
        } catch (err) {
          // Individual user check failed
        }
      }
    } catch (err) {
      console.error('[watcher:credit] Run failed:', err);
    }
  }, 45000); 

  // 3. Umbra Privacy Sync (Every 90s)
  setInterval(async () => {
    try {
      const wallets = await getAllWallets();
      for (const wallet of wallets) {
        if (wallet.umbra_registered) {
          try {
            const claimed = await syncPrivateCredits(wallet);
            if (claimed > 0) {
              console.log(`[watcher:umbra] Claimed ${claimed} private credits for ${wallet.telegram_id}`);
              await bot.api.sendMessage(wallet.telegram_id, 
                `🛡️ *Private Credit Detected!*\n\n` +
                `We have automatically detected and claimed *${claimed}* private transfer(s) to your wallet.\n\n` +
                `Your balance has been updated securely.`,
                { parse_mode: 'Markdown' }
              ).catch(() => null);
            }
          } catch (err) {
            console.error(`[watcher:umbra] Sync failed for ${wallet.telegram_id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[watcher:umbra] Run failed:', err);
    }
  }, 90000);

  // 4. Stealth Address Watcher (Every 2 minutes)
  setInterval(async () => {
    try {
      const processedCount = await processStealthReceivals(bot);
      if (processedCount > 0) {
        console.log(`[watcher:stealth] Processed ${processedCount} stealth deposits.`);
      }
    } catch (err) {
      console.error('[watcher:stealth] Run failed:', err);
    }
  }, 120000);
}
