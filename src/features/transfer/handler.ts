// src/features/transfer/handler.ts
// Handles SOL and USDC transfers between Solana wallets.

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { TransferIntent } from '../../types/index.js';
import { transferSol, transferUsdc, explorerLink } from '../../services/solana.js';
import { createTransaction, updateTransaction } from '../../services/transactions.js';
import { shortAddress } from '../../utils/helpers.js';
import { collectAndVerifyPin, handleSolanaNetworkError } from '../shared/conversation.js';

import { getClusterForAction } from '../../config/networks.js';

/**
 * Executes a SOL or USDC transfer after PIN verification.
 */
export async function executeTransfer(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: TransferIntent,
  wallet: any,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('TRANSFER');

  // ── Step 1: Confirmation ──────────────────────────────
  const tokenIcon = intent.token === 'SOL' ? '◎' : '💵';
  const summaryText =
    `💸 *Transfer Confirmation*\n\n` +
    `👤 *Recipient:* \`${shortAddress(intent.recipient)}\`\n` +
    `💰 *Amount:* ${tokenIcon} *${intent.amount} ${intent.token}*\n` +
    `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    `Confirm this ${intent.token} transfer?`;

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
  const processingMsg = await ctx.reply(`🛡️ *PIN verified! Generating Privacy Proof...*`, { parse_mode: 'Markdown' });

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: 'TRANSFER',
      amountNgn: 0,
      amountUsdc: intent.token === 'USDC' ? intent.amount : 0,
      amountSol: intent.token === 'SOL' ? intent.amount : 0,
      token: intent.token,
    }),
  );

  let signature: string;
  try {
    const mintAddress = intent.token === 'SOL' ? 'SOL' : process.env.USDC_MINT_ADDRESS!;
    const cluster = getClusterForAction('TRANSFER');
    
    // Use Umbra Privacy Send by default
    signature = await conversation.external(() =>
      sendPrivate(wallet, intent.recipient, intent.amount, mintAddress, cluster)
    );
  } catch (err: any) {
    await updateTransaction(txRecord.id, { status: 'failed', errorMessage: err.message });
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }
    
    await handleSolanaNetworkError(ctx, err);
    return;
  }

  await conversation.external(() => updateTransaction(txRecord.id, { status: 'completed', solanaTxSignature: signature }));
  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }

  await ctx.reply(
    `🎉 *Privacy Transfer Successful!* 🛡️\n\n` +
    `💰 Amount: ${intent.amount} ${intent.token}\n` +
    `👤 Recipient: \`${shortAddress(intent.recipient)}\`\n` +
    `🔐 *Status:* Shielded (Link Broken)\n` +
    `🔗 Explorer: [Solscan](${explorerLink(signature, cluster)})\n\n` +
    `This transaction is now invisible to public balance scanners.`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
  );
}

import { sendPrivate } from '../../services/umbra.js';
