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
import { createStealthReceiver } from '../../services/stealth.js';
import { InlineKeyboard } from 'grammy';

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
    `📥 *Onramp Summary*\n\n` +
    `💰 *Amount:* ${intent.amount} USDC\n` +
    `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    `Confirm this onramp? You will receive bank transfer details to pay.`;

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
      isStealth: false, // will be updated if chosen
    }),
  );

  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) {
    await ctx.reply('❌ No wallet found.');
    return;
  }

  // ── Step 3: Privacy Mode ──────────────────────────────
  const privacyKeyboard = new InlineKeyboard()
    .text('⚡ Standard (Fast)', 'privacy_off')
    .text('🤫 Pro-Privacy (Private)', 'privacy_on');

  await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, 
    `🤫 *Choose Your Privacy Mode*\n\n` +
    `⚡ *Standard:* Direct deposit to your wallet. Instant credit.\n\n` +
    `🤫 *Pro-Privacy:* Funds go to a temporary address first, then move to your wallet via *Umbra Mixer*.\n` +
    `• _Benefit:_ No link between payment and your wallet.\n` +
    `• _Tradeoff:_ ~2 minute delay for mixer consolidation.`,
    { parse_mode: 'Markdown', reply_markup: privacyKeyboard }
  );

  const privacyChoice = await conversation.waitForCallbackQuery(['privacy_off', 'privacy_on']);
  await privacyChoice.answerCallbackQuery();
  const isStealth = privacyChoice.callbackQuery.data === 'privacy_on';

  let recipientAddress = wallet.solana_public_key;
  if (isStealth) {
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, '⏳ *Generating stealth address...*', { parse_mode: 'Markdown' });
    const stealth = await conversation.external(() => createStealthReceiver(telegramId));
    recipientAddress = stealth.solana_public_key;
    await conversation.external(() => updateTransaction(txRecord.id, { isStealth: true }));
  }

  const reference = generateReference('PAJ');
  const pajResult = await conversation.external(() => getVirtualAccount({
    amount_ngn: ngnAmount,
    reference,
    recipient: recipientAddress
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

import { calculateNgnForCrypto, getNgnPerCrypto, SOL_MINT } from '../../services/price.js';

// ... (existing imports)

/**
 * Handles Onramp via Bank Transfer (Deposit).
 */
export async function executeDeposit(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: DepositIntent,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('BUY_USDC');
  const token = intent.token || 'USDC';
  const mint = token === 'SOL' ? SOL_MINT : undefined;

  // ── Step 1: Resolve Amount & Rate ──────────────────────
  let ngnAmount = intent.amount_ngn || 0;
  let cryptoAmount = intent.amount || 0;

  if (cryptoAmount > 0 && ngnAmount === 0) {
    // User said "deposit 1 usdc"
    ngnAmount = await conversation.external(() => calculateNgnForCrypto(cryptoAmount, token));
  } else if (ngnAmount > 0 && cryptoAmount === 0) {
    // User said "deposit 10000"
    const rate = await conversation.external(() => getNgnPerCrypto(token));
    const feePct = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5');
    cryptoAmount = (ngnAmount / (rate || 1600)) * (1 - feePct / 100);
  }

  // Minimum Amount Check (NGN)
  const MIN_DEPOSIT_NGN = 500;
  if (ngnAmount < MIN_DEPOSIT_NGN) {
    await ctx.reply(`❌ *Amount too low*\n\nThe minimum deposit is *${formatNGN(MIN_DEPOSIT_NGN)}*.`, { parse_mode: 'Markdown' });
    return;
  }

  // ── Step 2: Confirmation ──────────────────────────────
  // Skip confirmation if amount was provided in a direct intent command
  if (!intent.amount_ngn && !intent.amount) {
    const summaryText =
      `📥 *Deposit Request*\n\n` +
      `Generate a virtual account for your deposit?\n` +
      `_You will receive ${token} upon completion._`;

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
  }

  // ── Step 3: Execution ─────────────────────────────────
  const loadingMsg = await ctx.reply(`⏳ *Generating your ${token} deposit details...*`, { parse_mode: 'Markdown' });

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: 'DEPOSIT',
      amountNgn: ngnAmount,
      amountUsdc: token === 'USDC' ? cryptoAmount : 0,
      amountSol: token === 'SOL' ? cryptoAmount : 0,
      token,
      cluster,
      isStealth: false,
    }),
  );

  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) {
    await ctx.reply('❌ No wallet found.');
    return;
  }

  // ── Step 4: Privacy Mode ──────────────────────────────
  const privacyKeyboard = new InlineKeyboard()
    .text('⚡ Standard (Fast)', 'privacy_off')
    .text('🤫 Pro-Privacy (Private)', 'privacy_on');

  await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, 
    `🤫 *Choose Your Privacy Mode*\n\n` +
    `⚡ *Standard:* Direct deposit to your wallet.\n\n` +
    `🤫 *Pro-Privacy:* Funds route through *Umbra Mixer*.\n` +
    `• _Benefit:_ No link between payment and your wallet.\n` +
    `• _Tradeoff:_ ~2 minute delay for mixer consolidation.`,
    { parse_mode: 'Markdown', reply_markup: privacyKeyboard }
  );

  const privacyChoice = await conversation.waitForCallbackQuery(['privacy_off', 'privacy_on']);
  await privacyChoice.answerCallbackQuery();
  const isStealth = privacyChoice.callbackQuery.data === 'privacy_on';

  let recipientAddress = wallet.solana_public_key;
  if (isStealth) {
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, '⏳ *Generating stealth address...*', { parse_mode: 'Markdown' });
    const stealth = await conversation.external(() => createStealthReceiver(telegramId));
    recipientAddress = stealth.solana_public_key;
    await conversation.external(() => updateTransaction(txRecord.id, { isStealth: true }));
  }

  const reference = generateReference('PAJ');
  const pajResult = await conversation.external(() => getVirtualAccount({
    amount_ngn: ngnAmount,
    reference,
    recipient: recipientAddress,
    mint
  }));

  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch { /* ignore */ }

  if (pajResult.success) {
    const data = pajResult.data as any;
    const icon = token === 'SOL' ? '◎' : '💵';
    // Build estimate note — PAJ applies their own spread at fulfillment time
    const estimateNote = ngnAmount > 0
      ? `\n💱 *Estimated:* ~${icon} ${cryptoAmount.toFixed(4)} ${token} \_(actual amount may vary slightly based on PAJ's live rate)_`
      : '';

    const instrMsg = await ctx.reply(
      `🏦 *Deposit Instructions*\n\n` +
      `Please send exactly *${formatNGN(ngnAmount)}* to the account below:\n` +
      `${estimateNote}\n\n` +
      `🏛️ *Bank:* ${data.bank_name || 'Wema Bank'}\n` +
      `🔢 *Account Number:* \`${data.account_number || '0123456789'}\`\n` +
      `👤 *Account Name:* ${data.account_name || 'FLX - Deposit'}\n\n` +
      `📋 *Reference:* \`${reference}\`\n\n` +
      `⏰ _Valid for 15 minutes. Your ${token} balance will update automatically once PAJ confirms payment._`,
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
    await ctx.reply(`❌ *Failed to generate ${token} deposit details*\n\n${pajResult.message}`);
  }
}
