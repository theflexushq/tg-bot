// src/handlers/purchase.ts
// The core transaction conversation:
//   1. Parse user message → structured intent (AI)
//   2. Fetch price quote (oracle)
//   3. Show summary + Confirm/Cancel keyboard
//   4. Collect PIN (grammY conversation await)
//   5. Verify PIN (bcrypt)
//   6. Transfer USDC on Solana
//   7. Trigger paj_ramp payout
//   8. Reply with receipt

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../types/context.js';
import { parseIntent } from '../services/ai.js';
import { getWallet, isPinLocked } from '../services/wallet.js';
import { getUsdcBalance, getSolBalance } from '../services/solana.js';
import { ParsedIntent } from '../types/index.js';
import { getClusterForAction } from '../config/networks.js';

// Modular Feature Handlers
import { executeTransfer } from '../features/transfer/handler.js';
import { executeOfframp } from '../features/offramp/handler.js';
import { executeOnramp, executeDeposit } from '../features/onramp/handler.js';
import { executeUtility } from '../features/utility/handler.js';
import { checkBalance } from '../features/shared/conversation.js';

// ── Message handler (entry point from bot.on('message:text')) ─

export async function handleUserMessage(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const telegramId = String(ctx.from?.id);
  const wallet = await getWallet(telegramId);

  if (!wallet) {
    await ctx.reply('Please use /start first to set up your wallet.');
    return;
  }

  if (!wallet.pin_set) {
    await ctx.reply('⚠️ Please set your PIN first. Use /start to complete setup.');
    return;
  }

  // Check PIN lockout before doing anything
  const lockStatus = await isPinLocked(wallet);
  if (lockStatus.locked) {
    await ctx.reply(
      `🔒 Your wallet is temporarily locked due to too many failed PIN attempts.\n` +
      `Try again in *${lockStatus.minutesLeft} minute(s)*`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Re-entrance guard: Don't start a new purchase flow if one is already active
  const activeConversations = await ctx.conversation.active();
  if (Object.keys(activeConversations).length > 0) {
    console.log(`[IRON-DISPATCH] User ${ctx.from?.id} already has active conversations: ${Object.keys(activeConversations)}`);
    return;
  }

  // Enter the purchase conversation
  await ctx.conversation.enter('purchaseFlow');
}

// ── Master Dispatcher Conversation ────────────────────────────

export async function purchaseFlowConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const userText = ctx.message?.text ?? '';

  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) {
    await ctx.reply('Wallet not found. Please use /start.');
    return;
  }

  // ── Step 1: Parse intent ──────────────────────────────────
  const typingMsg = await ctx.reply('Parsing your request...');

  let intent: ParsedIntent;
  try {
    intent = await conversation.external(() => parseIntent(userText));
  } catch (err) {
    await ctx.reply('AI service unavailable. Please try again.');
    return;
  }

  // Delete typing indicator
  if (ctx.chat) {
    try { await ctx.api.deleteMessage(ctx.chat.id, typingMsg.message_id); } catch { /* ignore */ }
  }

  // Handle unknown/clarification intent
  if (intent.action === 'UNKNOWN') {
    await ctx.reply(intent.message);
    return;
  }

  // ── Step 2: Route to Module with Network Context ──────────
  const cluster = getClusterForAction(intent.action);
  
  try {
    if (intent.action === 'TRANSFER') {
      const { success, balance } = await checkBalance(conversation, wallet.solana_public_key, intent.token, intent.amount, cluster);
      if (!success) {
        await ctx.reply(`❌ *Insufficient ${intent.token} balance on ${cluster}*\nRequired: ${intent.amount}\nAvailable: ${balance}`, { parse_mode: 'Markdown' });
        return;
      }
      await executeTransfer(conversation, ctx, intent, wallet);
    } 
    else if (intent.action === 'OFFRAMP') {
      const { success, balance } = await checkBalance(conversation, wallet.solana_public_key, intent.token, intent.amount, cluster);
      if (!success) {
        await ctx.reply(`❌ *Insufficient ${intent.token} balance on ${cluster} for offramp*\nRequired: ${intent.amount}\nAvailable: ${balance}`, { parse_mode: 'Markdown' });
        return;
      }
      await executeOfframp(conversation, ctx, intent, wallet);
    } 
    else if (intent.action === 'BUY_USDC' || intent.action === 'DEPOSIT') {
      // Deposits are bank based, no crypto balance check needed beforehand
      await executeDeposit(conversation, ctx, intent as any);
    }
    else if (intent.action === 'BUY_AIRTIME' || intent.action === 'BUY_DATA') {
      // Balance check for utility depends on NGN quote, handled inside module
      await executeUtility(conversation, ctx, intent, wallet);
    } 
    else {
      await ctx.reply('⚠️ This transaction type is not supported yet.');
    }
  } catch (err: any) {
    console.error('[dispatcher] Feature execution failed:', err);
    // Escape underscores so they don't break Markdown parsing
    const safeError = String(err?.message || err).replace(/_/g, '\\_');
    await ctx.reply(
      `❌ *Transaction Error*\n\n` +
      `An unexpected error occurred: ${safeError}`,
      { parse_mode: 'Markdown' },
    );
  }
}
