// src/features/utility/handler.ts
// Handles utility payments: Airtime and Data bundles via paj_ramp.

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { AirtimeIntent, DataIntent } from '../../types/index.js';
import { transferUsdcToTreasury, explorerLink } from '../../services/solana.js';
import { createTransaction, updateTransaction } from '../../services/transactions.js';
import { sendAirtime, sendData } from '../../services/pajRamp.js';
import { collectAndVerifyPin, handleSolanaNetworkError } from '../shared/conversation.js';
import { normalisePhone, detectNetwork, formatNGN } from '../../utils/helpers.js';
import { generateReference } from '../../utils/crypto.js';
import { buildQuote, formatQuote } from '../../services/price.js';

import { getClusterForAction } from '../../config/networks.js';

export async function executeUtility(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: AirtimeIntent | DataIntent,
  wallet: any,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('BUY_AIRTIME'); // Same for Data

  // ── Step 1: Normalisation ──────────────────────────────
  const phone = normalisePhone(intent.phone_number);
  const network = intent.network ?? detectNetwork(phone);
  const amountNgn = intent.amount_ngn;
  const planMb = intent.action === 'BUY_DATA' ? intent.plan_mb : undefined;

  // ── Step 2: Quoting ──────────────────────────────────
  const quote = await conversation.external(() => buildQuote(amountNgn));
  
  // ── Step 3: Confirmation ──────────────────────────────
  const actionLabel = intent.action === 'BUY_AIRTIME' ? '📱 Airtime' : '🌐 Data Bundle';
  const dataLabel = planMb ? `\n📦 *Plan:* ${planMb >= 1024 ? `${planMb / 1024}GB` : `${planMb}MB`}` : '';

  const summaryText =
    `${actionLabel} *Purchase Summary*\n\n` +
    `📞 *Phone:* \`${phone}\`\n` +
    `📡 *Network:* ${network}${dataLabel}\n` +
    `💰 *Amount:* ${formatNGN(amountNgn)}\n` +
    `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    formatQuote(quote) +
    `\n\nConfirm this transaction?`;

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

  // ── Step 4: PIN ──────────────────────────────────────
  const pinVerified = await collectAndVerifyPin(conversation, ctx, telegramId);
  if (!pinVerified) return;

  // ── Step 5: Execution ─────────────────────────────────
  const processingMsg = await ctx.reply(`⚡ *PIN verified! Processing on Solana (${cluster})...*`, { parse_mode: 'Markdown' });

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: intent.action as any,
      amountNgn,
      amountUsdc: quote.usdc_amount,
      token: 'USDC',
      phoneNumber: phone,
      network: network!,
    }),
  );

  let signature: string;
  try {
    signature = await conversation.external(() => transferUsdcToTreasury(wallet, quote.usdc_amount, cluster));
  } catch (err: any) {
    await updateTransaction(txRecord.id, { status: 'failed', errorMessage: err.message });
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }
    await ctx.reply(`❌ *Solana transaction failed*\n\n${err.message}`, { parse_mode: 'Markdown' });
    return;
  }

  await conversation.external(() => updateTransaction(txRecord.id, { status: 'paj_triggered', solanaTxSignature: signature }));
  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }

  await ctx.reply(
    `✅ *Solana confirmed!*\n\n` +
    `Tx: [View on Solscan](${explorerLink(signature, cluster)})\n\n` +
    `⚡ Sending ${intent.action === 'BUY_AIRTIME' ? 'airtime' : 'data'} now...`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
  );

  const reference = generateReference('PAJ');
  let pajResult;
  if (intent.action === 'BUY_AIRTIME') {
    pajResult = await conversation.external(() => sendAirtime({ phone, network: network!, amount: amountNgn, reference }));
  } else {
    pajResult = await conversation.external(() => sendData({ phone, network: network!, plan_mb: planMb!, reference }));
  }

  if (pajResult.success) {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'completed', pajRampReference: reference }));
    await ctx.reply(
      `🎉 *${intent.action === 'BUY_AIRTIME' ? 'Airtime' : 'Data'} sent successfully!*\n\n` +
      `📞 Phone: \`${phone}\`\n` +
      `💰 Amount: ${formatNGN(amountNgn)}\n` +
      `🔗 Solana Tx: [Solscan](${explorerLink(signature)})\n` +
      `📋 Reference: \`${reference}\`\n\n` +
      `Need anything else?`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  } else {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'failed', errorMessage: pajResult.message, pajRampReference: reference }));
    await ctx.reply(`⚠️ *Partial failure — action required*\n\nFunds sent but delivery failed.\n📋 *Ref:* \`${reference}\``, { parse_mode: 'Markdown' });
  }
}
