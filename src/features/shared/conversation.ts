// src/features/shared/conversation.ts
// Shared conversation steps: PIN verification, balance checking, and network error handling.

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { getWallet, verifyPin } from '../../services/wallet.js';
import { getUsdcBalance, getSolBalance } from '../../services/solana.js';
import { isValidPin } from '../../utils/helpers.js';

/**
 * Common PIN collection and verification logic.
 * Deletes PIN message immediately and handles lockout.
 */
export async function collectAndVerifyPin(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  telegramId: string,
): Promise<boolean> {
  const pinPrompt = await ctx.reply(
    `🔐 *Enter your 4-digit PIN to authorise:*\n\n` +
    `_(Your message will be deleted immediately)_`,
    { parse_mode: 'Markdown' },
  );

  const maxAttempts = parseInt(process.env.MAX_PIN_ATTEMPTS ?? '3');
  let pinVerified = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pinMsg = await conversation.waitFor('message:text');
    const pinInput = pinMsg.msg.text.trim();

    // Delete PIN message immediately
    if (ctx.chat) {
      try { await ctx.api.deleteMessage(ctx.chat.id, pinMsg.msg.message_id); } catch { /* ignore */ }
    }

    if (!isValidPin(pinInput)) {
      await ctx.reply('❌ PIN must be 4 digits. Try again:');
      continue;
    }

    const freshWallet = await conversation.external(() => getWallet(telegramId));
    if (!freshWallet) { await ctx.reply('Wallet error. Please /start again.'); return false; }

    const pinResult = await conversation.external(() => verifyPin(freshWallet, pinInput));

    if (pinResult.locked) {
      await ctx.reply(
        `🔒 *Wallet locked!*\n\nToo many incorrect PIN attempts. Try again in *${process.env.PIN_LOCKOUT_MINUTES ?? 15} minutes*.`,
        { parse_mode: 'Markdown' },
      );
      return false;
    }

    if (pinResult.success) {
      pinVerified = true;
      break;
    }

    const attemptsLeft = pinResult.attemptsLeft ?? (maxAttempts - attempt);
    if (attemptsLeft > 0) {
      await ctx.reply(`❌ Incorrect PIN. *${attemptsLeft} attempt(s) left:*`, { parse_mode: 'Markdown' });
    }
  }

  if (ctx.chat) {
    try { await ctx.api.deleteMessage(ctx.chat.id, pinPrompt.message_id); } catch { /* ignore */ }
  }

  if (!pinVerified) {
    await ctx.reply('🔒 Transaction cancelled — too many incorrect PIN attempts.');
    return false;
  }

  return true;
}

/**
 * Common Solana network error message.
 */
export async function handleSolanaNetworkError(ctx: BotContext, err: any) {
  console.error('[solana] Network error:', err);
  await ctx.reply(
    `⚠️ *Blockchain Network Error*\n\n` +
    `Unable to reach the Solana network. This is usually temporary.\n\n` +
    `Please try again in a few minutes.`,
    { parse_mode: 'Markdown' }
  );
}

import { SolanaCluster } from '../../config/networks.js';

/**
 * Checks the balance of a wallet based on the token and required amount.
 */
export async function checkBalance(
  conversation: Conversation<BotContext>,
  publicKey: string,
  token: 'SOL' | 'USDC',
  required: number,
  cluster: SolanaCluster = 'devnet',
): Promise<{ success: boolean; balance: number }> {
  const balance = token === 'SOL'
    ? await conversation.external(() => getSolBalance(publicKey, cluster))
    : await conversation.external(() => getUsdcBalance(publicKey, cluster));

  if (balance < required) {
    return { success: false, balance };
  }
  return { success: true, balance };
}
