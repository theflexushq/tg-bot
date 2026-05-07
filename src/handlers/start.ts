// src/handlers/start.ts
// Handles /start: checks for existing wallet, creates one if needed,
// then launches the PIN setup conversation if PIN not yet configured.

import { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import { BotContext } from '../types/context.js';
import { getWallet, createWallet, setPin } from '../services/wallet.js';
import { shortAddress, isValidPin } from '../utils/helpers.js';
import { InlineKeyboard } from 'grammy';
import { getClusterForAction } from '../config/networks.js';

// ── /start command ────────────────────────────────────────────

export async function startHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const username = ctx.from?.username ?? null;
  const firstName = ctx.from?.first_name ?? 'there';

  await ctx.reply('⏳ Setting up your account...');

  let wallet = await getWallet(telegramId);

  if (!wallet) {
    // Brand new user — create shadow wallet
    wallet = await createWallet(telegramId, username);

    await ctx.reply(
      `👋 *Welcome, ${firstName}!*\n\n` +
      `Your Solana wallet has been created:\n\n` +
      `\`${wallet.solana_public_key}\`\n\n` +
      `This wallet holds your USDC and SOL.\n\n` +
      `🔐 *Next:* Set a 4-digit PIN to authorise transactions.`,
      { parse_mode: 'Markdown' },
    );

    // Trigger PIN setup
    await ctx.conversation.enter('setupPin');
    return;
  }

  // Existing user — show dashboard
  if (!wallet.pin_set) {
    await ctx.reply(
      `👋 Welcome back, ${firstName}!\n\n` +
      `⚠️ You haven't set a PIN yet. Let's do that now.`,
    );
    await ctx.conversation.enter('setupPin');
    return;
  }

  await ctx.reply(
    `👋 *Welcome back, ${firstName}!*\n\n` +
    `💼 *Your wallet:*\n\`${wallet.solana_public_key}\`\n\n` +
    `Just tell me what you need:\n` +
    `• _"Buy ₦500 airtime for 08012345678"_\n` +
    `• _"Get 1GB data for 08087654321"_\n` +
    `• /deposit — Fund your wallet with Naira\n` +
    `• /sell — Sell crypto for Naira (Offramp)\n` +
    `• /balance — Check your USDC balance\n` +
    `• /history — Recent transactions\n` +
    `• /export — Export your private key\n` +
    `• /wallet — Your wallet address`,
    { parse_mode: 'Markdown' },
  );
}

// ── PIN Setup Conversation ────────────────────────────────────

export async function setupPinConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);

  const messagesToDelete: number[] = [];

  // Step 1: Ask for PIN
  const prompt1 = await ctx.reply(
    `🔐 *Set your 4-digit PIN*\n\n` +
    `This PIN authorises every transaction. Keep it secret — never share it.\n\n` +
    `Enter your 4-digit PIN:`,
    { parse_mode: 'Markdown' },
  );
  messagesToDelete.push(prompt1.message_id);

  let pin1: string | undefined;

  // Wait for a valid PIN
  while (true) {
    const pinMsg = await conversation.waitFor('message:text');
    const candidate = pinMsg.msg.text.trim();

    // Immediately delete the PIN message for privacy
    try {
      if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, pinMsg.msg.message_id);
    } catch { /* ignore */ }

    if (!isValidPin(candidate)) {
      const errorMsg = await ctx.reply('❌ PIN must be exactly 4 digits (numbers only). Try again:');
      messagesToDelete.push(errorMsg.message_id);
      continue;
    }

    pin1 = candidate;
    break;
  }

  // Step 2: Confirm PIN
  const prompt2 = await ctx.reply('🔐 Confirm your PIN — enter it again:');
  messagesToDelete.push(prompt2.message_id);

  while (true) {
    const confirmMsg = await conversation.waitFor('message:text');
    const candidate = confirmMsg.msg.text.trim();

    try {
      if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, confirmMsg.msg.message_id);
    } catch { /* ignore */ }

    if (!isValidPin(candidate)) {
      const errorMsg = await ctx.reply('❌ Must be 4 digits. Enter your PIN again to confirm:');
      messagesToDelete.push(errorMsg.message_id);
      continue;
    }

    if (candidate !== pin1) {
      const errorMsg = await ctx.reply("❌ PINs don't match. Let's start over — enter your new 4-digit PIN:");
      messagesToDelete.push(errorMsg.message_id);
      pin1 = undefined;

      // Re-prompt for first PIN
      while (true) {
        const retryMsg = await conversation.waitFor('message:text');
        const retryCandidate = retryMsg.msg.text.trim();
        try {
          if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, retryMsg.msg.message_id);
        } catch { /* ignore */ }

        if (!isValidPin(retryCandidate)) {
          const innerError = await ctx.reply('❌ Must be 4 digits. Try again:');
          messagesToDelete.push(innerError.message_id);
          continue;
        }
        pin1 = retryCandidate;
        break;
      }

      const confirmPrompt = await ctx.reply('Confirm your PIN:');
      messagesToDelete.push(confirmPrompt.message_id);
      continue;
    }

    // PINs match — save
    await conversation.external(async () => {
      await setPin(telegramId, pin1!);
    });

    break;
  }

  // Cleanup: Delete all tracked prompt messages
  if (ctx.chat) {
    try {
      await ctx.api.deleteMessages(ctx.chat.id, messagesToDelete);
    } catch (err) {
      console.warn('[setupPin] Failed to batch delete messages:', err);
      // Fallback: try individual deletion if batch fails
      for (const msgId of messagesToDelete) {
        await ctx.api.deleteMessage(ctx.chat.id, msgId).catch(() => null);
      }
    }
  }

  await ctx.reply(
    `✅ *PIN set successfully!*\n\n` +
    `Your wallet is ready. 🛡️ *Privacy Mode enabled by default.*\n\n` +
    `Deposit USDC and SOL to start transacting privately:\n\n` +
    `\`${(await conversation.external(() => getWallet(telegramId)))?.solana_public_key}\`\n\n` +
    `Try: _"Send 10 USDC to 7Au2r...."_`,
    { parse_mode: 'Markdown' },
  );

  // Auto-register for Umbra in background
  const finalWallet = await conversation.external(() => getWallet(telegramId));
  if (finalWallet) {
    try {
      await conversation.external(async () => {
        const cluster = getClusterForAction('TRANSFER');
        await registerUmbra(finalWallet, cluster);
        await updateUmbraRegistration(telegramId, true);
        console.log(`[setup] Umbra auto-registered for ${telegramId}`);
      });
    } catch (err) {
      console.error(`[setup] Umbra registration failed:`, err);
    }
  }
}

import { registerUmbra } from '../services/umbra.js';
import { updateUmbraRegistration } from '../services/wallet.js';
