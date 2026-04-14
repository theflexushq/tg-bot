// src/features/offramp/addBank.ts
// Logic for saving a user's bank account for fast offramping.

import { Conversation } from '@grammyjs/conversations';
import { BotContext } from '../../types/context.js';
import { getPopularBanks, searchBanks, resolveAccountName } from '../../services/pajRamp.js';
import { saveBankDetails } from '../../services/wallet.js';

export async function addBankConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);

  // 1. Select Bank (Reuse the Search Loop logic)
  let selectedBankName = '';
  let banks = await conversation.external(() => getPopularBanks());
  
  await ctx.reply(
    '🏦 *Add Bank Account*\n\nTap a popular bank below or type to search for yours:', 
    { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...banks.map(b => [{ text: b.name, callback_data: `addbank_id_${b.id}_${b.name}` }])
        ]
      }
    }
  );

  while (true) {
    const { message, callbackQuery } = await conversation.waitFor(['message:text', 'callback_query:data']);
    
    if (callbackQuery?.data.startsWith('addbank_id_')) {
      const parts = callbackQuery.data.split('_');
      selectedBankName = parts.slice(3).join('_'); // Get name
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

      await ctx.reply(
        `🔍 *Search Results for "${query}"*\nTap to select your bank:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...results.map(b => [{ text: b.name, callback_data: `addbank_id_${b.id}_${b.name}` }])
            ]
          }
        }
      );
    }
  }

  // 2. Collection Account Number
  await ctx.reply(`🔢 *Enter Account Number*\nWhat is your account number at *${selectedBankName}*?`, { parse_mode: 'Markdown' });
  const accMsg = await conversation.waitFor('message:text');
  const accountNumber = accMsg.msg.text.trim().replace(/[^0-9]/g, '');

  // 3. Resolve Account Name (Verification)
  const loadingMsg = await ctx.reply(`🔍 *Verifying account details at ${selectedBankName}...*`, { parse_mode: 'Markdown' });
  
  try {
    const resolution = await conversation.external(() => resolveAccountName(selectedBankName, accountNumber));
    
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch { /* ignore */ }

    // Final Confirmation
    await ctx.reply(
      `✅ *Account Verified!*\n\n` +
      `🏛️ Bank: ${selectedBankName}\n` +
      `🔢 Account: \`${accountNumber}\`\n` +
      `👤 Name: *${resolution.accountName}*\n\n` +
      `Would you like to save this as your default bank for payouts?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '💾 Save Bank', callback_data: 'confirm_save_bank' },
            { text: '❌ Cancel', callback_data: 'cancel_save_bank' }
          ]]
        }
      }
    );

    const confirmCtx = await conversation.waitForCallbackQuery(['confirm_save_bank', 'cancel_save_bank']);
    await confirmCtx.answerCallbackQuery();

    if (confirmCtx.callbackQuery.data === 'confirm_save_bank') {
      await conversation.external(() => saveBankDetails(telegramId, selectedBankName, accountNumber, resolution.accountName));
      await ctx.reply('✨ *Bank account saved successfully!*\n\nYou can now offramp faster than ever.', { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ Bank clearing cancelled.');
    }

  } catch (err: any) {
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch { /* ignore */ }
    await ctx.reply(`⚠️ *Verification Failed*\n\nReason: ${err.message}\n\nPlease try /addbank again with the correct details.`);
  }
}
