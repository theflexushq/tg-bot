import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { BuyUsdcIntent, DepositIntent } from '../../types/index.js';
import { getWallet } from '../../services/wallet.js';
import { createTransaction, updateTransaction } from '../../services/transactions.js';
import { getVirtualAccount } from '../../services/pajRamp.js';
import { collectAndVerifyPin } from '../shared/conversation.js';
import { generateReference } from '../../utils/crypto.js';
import { formatNGN } from '../../utils/helpers.js';
import { getClusterForAction } from '../../config/networks.js';
import { calculateNgnForUsdc } from '../../services/price.js';

/**
 * Handles Onramp via Payment Link (Buy USDC).
 */
export async function executeOnramp(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: BuyUsdcIntent,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('BUY_USDC');

  // ── Step 1: Confirmation ──────────────────────────────
  const summaryText =
    `🛒 *Buy USDC Summary*\n\n` +
    `💰 *Amount:* ${intent.amount} USDC\n` +
    `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    `Confirm this purchase? You will receive bank transfer details to pay.`;

  const confirmKeyboard = { 
    inline_keyboard: [[
      { text: '✅ Confirm', callback_data: 'confirm_purchase' },
      { text: '❌ Cancel', callback_data: 'cancel_purchase' }
    ]] 
  };

  const summaryMsg = await ctx.reply(summaryText, { parse_mode: 'Markdown', reply_markup: confirmKeyboard });
  const callbackCtx = await conversation.waitForCallbackQuery(['confirm_purchase', 'cancel_purchase']);
  await callbackCtx.answerCallbackQuery();

  try { await ctx.api.editMessageReplyMarkup(ctx.chat!.id, summaryMsg.message_id, { reply_markup: { inline_keyboard: [] } }); } catch { /* ignore */ }

  if (callbackCtx.callbackQuery.data === 'cancel_purchase') {
    await ctx.reply('❌ Transaction cancelled.');
    return;
  }

  // ── Step 2: PIN ──────────────────────────────────────
  const pinVerified = await collectAndVerifyPin(conversation, ctx, telegramId);
  if (!pinVerified) return;

  // ── Step 3: Execution ─────────────────────────────────
  const loadingMsg = await ctx.reply('⏳ *Generating your deposit details...*', { parse_mode: 'Markdown' });

  // Calculate Naira required
  const ngnAmount = await conversation.external(() => calculateNgnForUsdc(intent.amount));

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: 'BUY_USDC',
      amountNgn: ngnAmount,
      amountUsdc: intent.amount,
      token: 'USDC',
      cluster,
    }),
  );

  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) {
    await ctx.reply('❌ No wallet found.');
    return;
  }

  const reference = generateReference('PAJ');
  const pajResult = await conversation.external(() => getVirtualAccount({ 
    amount_ngn: ngnAmount, 
    reference,
    recipient: wallet.solana_public_key
  }));

  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch { /* ignore */ }

  if (pajResult.success) {
    const data = pajResult.data as any;
    const instrMsg = await ctx.reply(
        `🎉 *Onramp Initiated!*\n\n` +
        `To receive *${intent.amount} USDC*, please send exactly *${formatNGN(ngnAmount)}* to the account below:\n\n` +
        `🏛️ *Bank:* ${data.bank_name || 'Wema Bank'}\n` +
        `🔢 *Account Number:* \`${data.account_number || '0123456789'}\`\n` +
        `👤 *Account Name:* ${data.account_name || 'FLX - Deposit'}\n\n` +
        `📋 *Reference:* \`${reference}\`\n\n` +
        `_Your balance will be credited automatically once the transfer is confirmed._`,
        { parse_mode: 'Markdown' },
      );

    // Save message ID for auto-deletion on expiry
    await conversation.external(() => updateTransaction(txRecord.id, { 
      pajRampReference: reference,
      botMessageId: instrMsg.message_id,
      chatId: instrMsg.chat.id
    }));
  } else {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'failed', errorMessage: pajResult.message, pajRampReference: reference }));
    await ctx.reply(`⚠️ *Onramp initiation failed*\n\nError: ${pajResult.message}\n📋 *Ref:* \`${reference}\``, { parse_mode: 'Markdown' });
  }
}

/**
 * Handles Onramp via Bank Transfer (Deposit).
 */
export async function executeDeposit(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: DepositIntent,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('BUY_USDC'); // Deposits credit as USDC on this network

  // ── Step 0: Minimum Amount Check ──────────────────────
  const MIN_DEPOSIT_NGN = 500;
  if (intent.amount_ngn < MIN_DEPOSIT_NGN) {
    await ctx.reply(`❌ *Amount too low*\n\nThe minimum deposit is *${formatNGN(MIN_DEPOSIT_NGN)}*.`, { parse_mode: 'Markdown' });
    return;
  }

  // ── Step 1: Confirmation ──────────────────────────────
  const summaryText =
    `📥 *Deposit Request*\n\n` +
    `💰 *Amount:* ${formatNGN(intent.amount_ngn)}\n` +
    `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    `Generate a virtual account for this deposit?`;

  const confirmKeyboard = { 
    inline_keyboard: [[
      { text: '✅ Generate', callback_data: 'confirm_deposit' },
      { text: '❌ Cancel', callback_data: 'cancel_deposit' }
    ]] 
  };

  const summaryMsg = await ctx.reply(summaryText, { parse_mode: 'Markdown', reply_markup: confirmKeyboard });
  const callbackCtx = await conversation.waitForCallbackQuery(['confirm_deposit', 'cancel_deposit']);
  await callbackCtx.answerCallbackQuery();

  try { await ctx.api.editMessageReplyMarkup(ctx.chat!.id, summaryMsg.message_id, { reply_markup: { inline_keyboard: [] } }); } catch { /* ignore */ }

  if (callbackCtx.callbackQuery.data === 'cancel_deposit') {
    await ctx.reply('❌ Deposit cancelled.');
    return;
  }

  // ── Step 2: Execution ─────────────────────────────────
  const loadingMsg = await ctx.reply('⏳ *Generating your virtual account...*', { parse_mode: 'Markdown' });

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: 'DEPOSIT',
      amountNgn: intent.amount_ngn,
      amountUsdc: 0, 
      token: 'USDC',
      cluster,
    }),
  );

  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) {
    await ctx.reply('❌ No wallet found.');
    return;
  }

  const reference = generateReference('PAJ');
  const pajResult = await conversation.external(() => getVirtualAccount({ 
    amount_ngn: intent.amount_ngn, 
    reference,
    recipient: wallet.solana_public_key
  }));

  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch { /* ignore */ }

  if (pajResult.success) {
    const data = pajResult.data as any;
    const instrMsg = await ctx.reply(
        `🏦 *Deposit Instructions*\n\n` +
        `Send exactly *${formatNGN(intent.amount_ngn)}* to the account below. Your wallet will be credited automatically once received.\n\n` +
        `🏛️ *Bank:* ${data.bank_name || 'Wema Bank'}\n` +
        `🔢 *Account Number:* \`${data.account_number || '0123456789'}\`\n` +
        `👤 *Account Name:* ${data.account_name || 'FLX - Deposit'}\n\n` +
        `📋 *Reference:* \`${reference}\`\n\n` +
        `_The account is valid for 30 minutes._`,
        { parse_mode: 'Markdown' },
      );

    // Save message ID for auto-deletion on expiry
    await conversation.external(() => updateTransaction(txRecord.id, { 
      pajRampReference: reference,
      botMessageId: instrMsg.message_id,
      chatId: instrMsg.chat.id
    }));
  } else {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'failed', errorMessage: pajResult.message }));
    await ctx.reply(`❌ *Failed to generate deposit details*\n\n${pajResult.message}`);
  }
}
