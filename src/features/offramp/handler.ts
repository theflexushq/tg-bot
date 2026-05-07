// src/features/offramp/handler.ts
// Handles offramping (selling) crypto for Nigerian Naira (NGN).

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { OfframpIntent } from '../../types/index.js';
import { transferUsdcToTreasury, explorerLink } from '../../services/solana.js';
import { createTransaction, updateTransaction } from '../../services/transactions.js';
import { InlineKeyboard } from 'grammy';
import { sellCrypto, resolveAccountName, getPopularBanks, searchBanks } from '../../services/pajRamp.js';
import { collectAndVerifyPin, handleSolanaNetworkError } from '../shared/conversation.js';
import { generateReference } from '../../utils/crypto.js';
import { buildQuote, formatQuote } from '../../services/price.js';

import { getClusterForAction } from '../../config/networks.js';

export async function executeOfframp(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
  intent: OfframpIntent,
  wallet: any,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const cluster = getClusterForAction('OFFRAMP');
  const sessionEpoch = Date.now(); // Used to detect if a restart happened mid-flow
  
  console.log(`[IRON-OFFRAMP] Session ${sessionEpoch} started for user ${telegramId}`);

  // ── Step 0: Handle Naira Conversion ──────────────────
  let quoteDetails = '';
  if (intent.amount_ngn && intent.amount_ngn > 0) {
    const loadingQuoteMsg = await ctx.reply('⏳ *Fetching best exchange rate...*', { parse_mode: 'Markdown' });
    try {
      const quote = await conversation.external(() => buildQuote(intent.amount_ngn!));
      intent.amount = quote.usdc_amount;
      intent.token = 'USDC'; // Always USDC for Naira-denominated sales
      quoteDetails = `\n${formatQuote(quote)}\n`;

      try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingQuoteMsg.message_id); } catch { /* ignore */ }
    } catch (err: any) {
      try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingQuoteMsg.message_id); } catch { /* ignore */ }
      await ctx.reply(`❌ *Pricing Error*\n\nCould not get a live quote: ${err.message}`);
      return;
    }
  }

  // ── Step 1: Collect Bank Details (Search Loop) ─────────
  let resolvedName = 'Unknown';
  if (!intent.bank_name) {
    // 🔍 FAST OFFRAMP: Check for saved bank
    if (wallet.saved_bank_name && wallet.saved_account_number) {
      console.log(`[offramp] Saved bank detected for user ${telegramId}`);
      const fastOfframpMsg = await ctx.reply(
        `🪄 *Fast Offramp Detected!*\n\n` +
        `Send to your saved bank account?\n` +
        `🏛️ *Bank:* ${wallet.saved_bank_name}\n` +
        `🔢 *Account:* \`${wallet.saved_account_number}\`\n` +
        `👤 *Recipient:* ${wallet.saved_recipient_name}\n\n` +
        `_Tap a button below:_`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: `✅ Yes, send to ${wallet.saved_bank_name}`, callback_data: 'use_saved_bank' },
              { text: '🏦 Use Another Bank', callback_data: 'use_another_bank' }
            ]]
          }
        }
      );

      console.log('[offramp] Waiting for fast offramp choice...');
      const savedBankChoice = await conversation.waitForCallbackQuery(['use_saved_bank', 'use_another_bank']);
      console.log(`[offramp] Choice received: ${savedBankChoice.callbackQuery.data}`);
      await savedBankChoice.answerCallbackQuery();

      // CLEANUP: Remove buttons from the fast offramp prompt
      try {
        await ctx.api.editMessageReplyMarkup(ctx.chat!.id, fastOfframpMsg.message_id, { reply_markup: { inline_keyboard: [] } });
      } catch (err: any) {
        console.warn('[offramp] Failed to cleanup fast offramp buttons:', err.message);
      }

      if (savedBankChoice.callbackQuery.data === 'use_saved_bank') {
        intent.bank_name = wallet.saved_bank_name;
        intent.account_number = wallet.saved_account_number;
        resolvedName = wallet.saved_recipient_name || 'Verified User';
      }
    }

    // Normal bank collection if not using saved or no bank saved
    if (!intent.bank_name) {
      let banks = await conversation.external(() => getPopularBanks());
      let promptMsg = await ctx.reply(
        '🏦 *Select/Enter Bank Name*\n\nTap a popular bank below or type to search:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...banks.map(b => [{ text: b.name, callback_data: `bank_id_${b.id}_${b.name}` }])
            ]
          }
        }
      );

      while (true) {
        const { message, callbackQuery } = await conversation.waitFor(['message:text', 'callback_query:data']);

        if (callbackQuery?.data.startsWith('bank_id_')) {
          const parts = callbackQuery.data.split('_');
          intent.bank_name = parts.slice(3).join('_'); // Get the name
          await ctx.api.answerCallbackQuery(callbackQuery.id);
          break;
        }

        if (message?.text) {
          const query = message.text.trim();
          const results = await conversation.external(() => searchBanks(query));

          if (results.length === 0) {
            await ctx.reply(`❌ No banks found matching "${query}". Try another name:`);
            continue;
          }

          // Update suggestions
          await ctx.reply(
            `🔍 *Search Results for "${query}"*\nTap to select:`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  ...results.map(b => [{ text: b.name, callback_data: `bank_id_${b.id}_${b.name}` }])
                ]
              }
            }
          );
        }
      }
    }
  }

  if (!intent.account_number) {
    await ctx.reply(`🔢 *Enter Account Number*\nWhat is the account number at *${intent.bank_name}*?`, { parse_mode: 'Markdown' });
    const msg = await conversation.waitFor('message:text');
    intent.account_number = msg.msg.text.trim().replace(/[^0-9]/g, '');
  }

  // ── Step 1b: Resolve Account Name (only if not already resolved via fast offramp) ─
  if (resolvedName === 'Unknown') {
    const loadingNameMsg = await ctx.reply(`🔍 *Resolving account name at ${intent.bank_name}...*`, { parse_mode: 'Markdown' });

    try {
      const resolution = await conversation.external(() => resolveAccountName(intent.bank_name, intent.account_number!));
      resolvedName = resolution.accountName;
      intent.bank_name = resolution.matchedBankName; // Use official name

      try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingNameMsg.message_id); } catch { /* ignore */ }
    } catch (err: any) {
      try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingNameMsg.message_id); } catch { /* ignore */ }
      await ctx.reply(`⚠️ *Account Resolution Failed*\n\nReason: ${err.message}\n\nPlease double check your bank and account number.`);
      return;
    }
  }

  // ── Step 2: Confirmation ──────────────────────────────
  const summaryText =
    `🏦 *Offramp Summary*\n\n` +
    (quoteDetails ? `${quoteDetails}\n` : `💰 *Amount:* ${intent.amount} ${intent.token}\n`) +
    `🏛️ *Bank:* ${intent.bank_name}\n` +
    `🔢 *Account:* \`${intent.account_number}\`\n` +
    `👤 *Recipient:* *${resolvedName}*\n` +
    // `🌐 *Network:* ${cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}\n\n` +
    `⚠️ *Ensure account details are correct.*`;

  const confirmKeyboard = {
    inline_keyboard: [[
      { text: '✅ Confirm & Pay', callback_data: 'confirm_offramp' },
      { text: '❌ Cancel', callback_data: 'cancel_offramp' }
    ]]
  };

  const summaryMsg = await ctx.reply(summaryText, { parse_mode: 'Markdown', reply_markup: confirmKeyboard });
  
  console.log(`[IRON-OFFRAMP] Waiting for final confirmation (Epoch: ${sessionEpoch})...`);
  
  let finalChoice: string | undefined;
  while (!finalChoice) {
    const newUpdate = await conversation.wait();
    
    if (newUpdate.callbackQuery) {
        const data = newUpdate.callbackQuery.data;
        if (data === 'confirm_offramp' || data === 'cancel_offramp') {
            finalChoice = data;
            await newUpdate.answerCallbackQuery();
            console.log(`[IRON-OFFRAMP] Button caught: ${finalChoice}`);
        } else {
            console.log(`[IRON-OFFRAMP] Ignoring unrelated button: ${data}`);
            await newUpdate.answerCallbackQuery();
        }
    } else {
        console.log(`[IRON-OFFRAMP] Ignoring non-button update`);
    }
  }

  // CLEANUP: Remove buttons
  try { await ctx.api.editMessageReplyMarkup(ctx.chat!.id, summaryMsg.message_id, { reply_markup: { inline_keyboard: [] } }); } catch { /* ignore */ }

  if (finalChoice === 'cancel_offramp') {
    await ctx.reply('❌ Offramp cancelled.');
    return;
  }

  // ── Step 3: PIN ──────────────────────────────────────
  console.log('[IRON-OFFRAMP] Moving to PIN collection...');
  const pinVerified = await collectAndVerifyPin(conversation, ctx, telegramId);
  if (!pinVerified) return;

  // ── Step 4: Execution ─────────────────────────────────
  const processingMsg = await ctx.reply(`⚡ *PIN verified! Processing on Solana (${cluster})...*`, { parse_mode: 'Markdown' });

  const txRecord = await conversation.external(() =>
    createTransaction({
      telegramId,
      action: 'OFFRAMP',
      amountNgn: intent.amount_ngn || 0,
      amountUsdc: intent.token === 'USDC' ? intent.amount : 0,
      amountSol: intent.token === 'SOL' ? intent.amount : 0,
      token: intent.token,
      cluster,
      bankName: intent.bank_name,
      recipientName: resolvedName,
    }),
  );

  let signature: string;
  try {
    signature = await conversation.external(() => transferUsdcToTreasury(wallet, intent.amount, cluster));
  } catch (err: any) {
    await updateTransaction(txRecord.id, { status: 'failed', errorMessage: err.message });
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }
    await handleSolanaNetworkError(ctx, err);
    return;
  }

  await conversation.external(() => updateTransaction(txRecord.id, { status: 'paj_triggered', solanaTxSignature: signature }));
  try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch { /* ignore */ }

  await ctx.reply(
    `✅ *Solana confirmed!*\n\n` +
    `Tx: [View on Solscan](${explorerLink(signature, cluster)})\n\n` +
    `⚡ Processing Naira payout now...`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
  );

  const reference = generateReference('PAJ');
  const pajResult = await conversation.external(() => sellCrypto({
    amount: intent.amount,
    token: intent.token,
    bank_name: intent.bank_name,
    account_number: intent.account_number!,
    reference
  }));

  if (pajResult.success) {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'completed', pajRampReference: reference }));
    await ctx.reply(
      `🎉 *Success! Naira payout initiated.*\n\n` +
      `💰 Amount: ${intent.amount} ${intent.token}\n` +
      `🏛️ Destination: ${intent.bank_name} (${intent.account_number})\n` +
      `📋 Reference: \`${reference}\`\n\n` +
      `Thank you for using Flexus!`,
      { parse_mode: 'Markdown' },
    );
  } else {
    await conversation.external(() => updateTransaction(txRecord.id, { status: 'failed', errorMessage: pajResult.message, pajRampReference: reference }));
    await ctx.reply(`⚠️ *Payout failure — Support notified*\n\nFunds sent to vault but payout failed: ${pajResult.message}\n📋 *Ref:* \`${reference}\``, { parse_mode: 'Markdown' });
  }
}
