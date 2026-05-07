// src/handlers/commands.ts
// Utility commands: /balance, /wallet, /history, /help, /changepin

import { Context, InlineKeyboard } from 'grammy';
import { BotContext } from '../types/context.js';
import { getUsdcBalance, getSolBalance } from '../services/solana.js';
import { getTransactionHistory, getTransactionStats } from '../services/transactions.js';
import { shortAddress, formatNGN, isValidPin } from '../utils/helpers.js';
import { Conversation } from '@grammyjs/conversations';
import { setPin, verifyPin, getWallet } from '../services/wallet.js';
import { createStealthReceiver } from '../services/stealth.js';

/**
 * /profile: Shows saved bank and transaction stats.
 */
export async function profileHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await getWallet(telegramId);

  if (!wallet) {
    await ctx.reply('Please /start first to set up your profile.');
    return;
  }

  const stats = await getTransactionStats(telegramId);

  const bankInfo = wallet.saved_bank_name
    ? `🏛️ *Bank:* ${wallet.saved_bank_name}\n🔢 *Account:* \`${wallet.saved_account_number}\`\n👤 *Name:* ${wallet.saved_recipient_name}`
    : `🏛️ *Bank:* _No bank saved yet._ Use /addbank to set one up.`;

  // Build simple table
  const actions = ['OFFRAMP', 'BUY_AIRTIME', 'TRANSFER', 'BUY_USDC', 'DEPOSIT'];
  let tableRows = '';
  for (const action of actions) {
    const count = stats[action] || 0;
    tableRows += `${action.padEnd(12)} | ${String(count).padStart(5)}\n`;
  }

  const summary =
    `👤 *YOUR PROFILE*\n\n` +
    `${bankInfo}\n\n` +
    `📊 *Transaction Summary:*\n` +
    `\`\`\`\n` +
    `Type         | Count\n` +
    `-------------|-------\n` +
    `${tableRows}` +
    `\`\`\``;

  await ctx.reply(summary, { parse_mode: 'Markdown' });
}
import { getClusterForAction } from '../config/networks.js';
import { decrypt } from '../utils/crypto.js';
import { executeDeposit } from '../features/onramp/handler.js';
import { executeOfframp } from '../features/offramp/handler.js';

// ── /balance ──────────────────────────────────────────────────

export async function balanceHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await getWallet(telegramId);

  if (!wallet) {
    await ctx.reply('No wallet found. Use /start to set up.');
    return;
  }

  // Get the cluster used for Onramp (where deposits land)
  const cluster = getClusterForAction('BUY_USDC');
  const networkName = cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet';

  const loadingMsg = await ctx.reply(`⏳ Fetching your balances on ${networkName}...`);

  const [usdc, sol] = await Promise.all([
    getUsdcBalance(wallet.solana_public_key, cluster),
    getSolBalance(wallet.solana_public_key, cluster),
  ]);

  if (ctx.chat) {
    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => null);
  }

  const solDisplay = sol > 0 ? `${sol.toFixed(6)} SOL` : `0 SOL ⚠️`;
  const solNote = sol > 0
    ? `_Small amount sent by PAJ to cover network fees._`
    : `_No SOL yet. PAJ will send a small amount with your next deposit._`;

  await ctx.reply(
    `💼 *Your Wallet Balance* (${networkName})\n\n` +
    `💵 *USDC:* ${usdc.toFixed(4)} USDC\n` +
    `◎ *SOL (for fees):* ${solDisplay}\n` +
    // `${solNote}\n\n` +
    `📥 *Deposit address:*\n\`${wallet.solana_public_key}\``,
    { parse_mode: 'Markdown' },
  );
}

// ── /wallet ───────────────────────────────────────────────────

export async function walletHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await getWallet(telegramId);

  if (!wallet) {
    await ctx.reply('No wallet found. Use /start to set up.');
    return;
  }

  const cluster = getClusterForAction('BUY_USDC');
  const networkName = cluster === 'mainnet-beta' ? 'Solana Mainnet' : 'Solana Devnet';

  await ctx.reply(
    `🔑 *Your Wallet*\n\n` +
    `*Address:*\n\`${wallet.solana_public_key}\`\n\n` +
    `_Copy this address to deposit USDC from any Solana wallet or exchange._`,
    { parse_mode: 'Markdown' },
  );
}

// ── /history ──────────────────────────────────────────────────

export async function historyHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const transactions = await getTransactionHistory(telegramId, 5);

  if (transactions.length === 0) {
    await ctx.reply('No transactions yet. Try: _"Buy ₦500 airtime for 08012345678"_', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const statusEmoji: Record<string, string> = {
    pending: '⏳',
    solana_confirmed: '🔗',
    paj_triggered: '⚡',
    completed: '✅',
    failed: '❌',
    refunded: '↩️',
  };

  const lines = transactions.map((tx, i) => {
    const emoji = statusEmoji[tx.status] ?? '•';
    const date = new Date(tx.created_at).toLocaleDateString('en-NG', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    const icon = {
      BUY_AIRTIME: '📱',
      BUY_DATA: '🌐',
      TRANSFER: '💸',
      OFFRAMP: '🏦',
      BUY_USDC: '🪙',
      DEPOSIT: '💰',
      PAY_BILL: '🧾',
    }[tx.action] ?? '•';

    const amountStr = tx.token === 'SOL'
      ? `${tx.amount_sol.toFixed(4)} SOL`
      : tx.action === 'OFFRAMP' || tx.action === 'TRANSFER' || tx.action === 'BUY_USDC'
        ? `${tx.amount_usdc.toFixed(2)} USDC`
        : formatNGN(tx.amount_ngn);

    return (
      `${emoji} ${icon} *${tx.action.replace('_', ' ')}* — ${amountStr}\n` +
      `   ${tx.phone_number ? `📞 ${tx.phone_number} • ` : ''}${date}`
    );
  });

  await ctx.reply(
    `📋 *Last ${transactions.length} Transactions*\n\n` + lines.join('\n\n'),
    { parse_mode: 'Markdown' },
  );
}

// ── /help ─────────────────────────────────────────────────────

export async function helpHandler(ctx: BotContext): Promise<void> {
  await ctx.reply(
    `🤖 *How to use this bot*\n\n` +
    `*Commands:*\n` +
    `/start — Set up or view your wallet\n` +
    `/balance — Check your USDC balance\n` +
    `/deposit — Fund your wallet with Naira\n` +
    `/sell — Sell crypto for Naira (Offramp)\n` +
    `/send — Send crypto to any address\n` +
    `/receive — Show your wallet QR code\n` +
    `/wallet — Your deposit address\n` +
    `/history — Recent transactions\n` +
    `/changepin — Change your 4-digit PIN\n` +
    `/help — This message\n\n` +
    `*Natural language (just type!):*\n` +
    `• _"Deposit 5000"_\n` +
    `• _"Buy ₦1000 airtime for 08012345678"_\n` +
    `• _"Send 100 USDC to 7A2r..."_\n` +
    `• _"Receive with QR Code"_\n` +
    // `• _"Get 1GB data for 09087654321"_\n` +
    // `• _"Recharge 2k Glo data for 08087654321"_\n\n` +
    // `*Supported networks:* MTN, Glo, Airtel, 9Mobile\n`,
    { parse_mode: 'Markdown' },
  );
}

// ── /changepin conversation ───────────────────────────────────

export async function changePinConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await conversation.external(() => getWallet(telegramId));

  if (!wallet || !wallet.pin_set) {
    await ctx.reply('No PIN set yet. Use /start to set one.');
    return;
  }

  // Verify current PIN first
  await ctx.reply('🔐 Enter your *current* PIN to continue:', { parse_mode: 'Markdown' });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const msg = await conversation.waitFor('message:text');
    try {
      if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, msg.msg.message_id);
    } catch { /* ignore */ }

    const input = msg.msg.text.trim();
    const freshWallet = await conversation.external(() => getWallet(telegramId));

    const result = await conversation.external(() => verifyPin(freshWallet!, input));

    if (result.locked) {
      await ctx.reply('🔒 Wallet locked due to too many attempts. Try later.');
      return;
    }

    if (result.success) break;

    if (attempt < 3) {
      await ctx.reply(`❌ Incorrect. ${result.attemptsLeft} attempt(s) left:`);
    } else {
      await ctx.reply('❌ Too many incorrect attempts. PIN change cancelled.');
      return;
    }
  }

  // Now set the new PIN
  await ctx.reply('✅ Verified! Enter your *new* 4-digit PIN:', { parse_mode: 'Markdown' });

  let newPin: string | undefined;
  while (true) {
    const msg = await conversation.waitFor('message:text');
    try {
      if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, msg.msg.message_id);
    } catch { /* ignore */ }

    const candidate = msg.msg.text.trim();
    if (!isValidPin(candidate)) {
      await ctx.reply('❌ Must be 4 digits. Try again:');
      continue;
    }
    newPin = candidate;
    break;
  }

  await ctx.reply('Confirm your new PIN:');
  while (true) {
    const msg = await conversation.waitFor('message:text');
    try {
      if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, msg.msg.message_id);
    } catch { /* ignore */ }

    const candidate = msg.msg.text.trim();
    if (candidate !== newPin) {
      await ctx.reply("❌ PINs don't match. Enter your new PIN again:");
      while (true) {
        const m2 = await conversation.waitFor('message:text');
        try {
          if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, m2.msg.message_id);
        } catch { /* ignore */ }
        const c2 = m2.msg.text.trim();
        if (!isValidPin(c2)) { await ctx.reply('❌ Must be 4 digits:'); continue; }
        newPin = c2;
        break;
      }
      await ctx.reply('Confirm new PIN:');
      continue;
    }
    break;
  }

  await conversation.external(() => setPin(telegramId, newPin!));
  await ctx.reply('✅ *PIN changed successfully!*', { parse_mode: 'Markdown' });
}

// ── /export conversation ──────────────────────────────────────

export async function exportConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await conversation.external(() => getWallet(telegramId));

  if (!wallet) return;

  // 1. PIN Verification
  await ctx.reply(
    '🔐 *Security Verification*\n\n' +
    'Extracting your Private Key is a high-risk action.\n' +
    'Please enter your *4-digit PIN* to continue:',
    { parse_mode: 'Markdown' }
  );

  let verified = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const msg = await conversation.waitFor('message:text');
    try { if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, msg.msg.message_id); } catch { /* ignore */ }

    const input = msg.msg.text.trim();
    const result = await conversation.external(() => verifyPin(wallet, input));

    if (result.locked) {
      await ctx.reply('🔒 Wallet locked due to too many attempts.');
      return;
    }

    if (result.success) {
      verified = true;
      break;
    }

    if (attempt < 3) {
      await ctx.reply(`❌ Incorrect. ${result.attemptsLeft} attempt(s) left:`);
    } else {
      await ctx.reply('❌ Too many incorrect attempts. Export cancelled.');
      return;
    }
  }

  if (!verified) return;

  // 2. Decrypt and Display
  const privateKeyBase58 = await conversation.external(() => decrypt(wallet.encrypted_private_key));

  const deleteKeyboard = new InlineKeyboard().text('🗑️ Delete Message', 'delete_this_msg');

  const warningMsg = await ctx.reply(
    '🔑 *Your Solana Private Key (Secret Key)*\n\n' +
    '⚠️ *NEVER SHARE THIS KEY.* Anyone with this key has full control over your funds.\n\n' +
    '```' + privateKeyBase58 + '```\n\n' +
    '_Copy this key and import it into Phantom or Solflare by selecting "Import Private Key"._\n\n' +
    '💡 *Tip:* After you have successfully backed it up, click the button below to remove this message from your chat history.',
    {
      parse_mode: 'Markdown',
      reply_markup: deleteKeyboard
    }
  );
}

export async function exportHandler(ctx: BotContext): Promise<void> {
  await ctx.conversation.enter('exportConversation');
}

// ── /deposit conversation ─────────────────────────────────────

export async function depositConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  // 1. Check if amount was already provided in the command
  let amountStr = ctx.match as string;
  let amount: number;

  if (!amountStr) {
    await ctx.reply('💰 *Deposit Naira*\n\nHow much would you like to deposit (NGN)?', { parse_mode: 'Markdown' });
    const msg = await conversation.waitFor('message:text');
    amountStr = msg.msg.text.trim();
  }

  // Sanitize and parse
  amountStr = amountStr.replace(/[^0-9]/g, '');
  amount = parseInt(amountStr);

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Invalid amount. Please enter a number (e.g., 5000).');
    return;
  }

  // 2. Delegate to the core onramp handler
  await executeDeposit(conversation, ctx, {
    action: 'DEPOSIT',
    amount_ngn: amount,
  });
}

export async function depositHandler(ctx: BotContext): Promise<void> {
  await ctx.conversation.enter('depositConversation');
}

// ── /sell conversation ────────────────────────────────────────

export async function sellConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) return;

  // 1. Parse arguments: /sell [amount] [token]
  const args = (ctx.match as string || '').split(/\s+/).filter(Boolean);
  let amountStr = args[0];
  let tokenStr = args[1]?.toUpperCase();

  // If no amount, prompt
  if (!amountStr) {
    await ctx.reply('🏦 *Sell Crypto (Offramp)*\n\nHow much would you like to sell? (e.g., 10 USDC)', { parse_mode: 'Markdown' });
    const msg = await conversation.waitFor('message:text');
    amountStr = msg.msg.text.trim();
  }

  // Auto-detect token from amountStr (e.g., "10 usdc", "10sol")
  if (!tokenStr) {
    const upper = amountStr.toUpperCase();
    if (upper.includes('USDC')) tokenStr = 'USDC';
    else if (upper.includes('SOL')) tokenStr = 'SOL';
  }

  // If still no token, prompt
  if (!tokenStr || (tokenStr !== 'USDC' && tokenStr !== 'SOL')) {
    const tokenKeyboard = new InlineKeyboard().text('USDC', 'sell_USDC').text('SOL', 'sell_SOL');
    await ctx.reply('Which token would you like to sell?', { reply_markup: tokenKeyboard });
    const callbackCtx = await conversation.waitForCallbackQuery(['sell_USDC', 'sell_SOL']);
    await callbackCtx.answerCallbackQuery();
    tokenStr = callbackCtx.callbackQuery.data.split('_')[1] as 'USDC' | 'SOL';
  }

  const amountValue = amountStr.replace(/[^0-9.]/g, '');
  const amount = parseFloat(amountValue);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Invalid amount. Please try again.');
    return;
  }

  // Detect if it's a Naira amount
  const upper = amountStr.toUpperCase();
  const isNaira = upper.includes('NAIRA') || upper.includes('NGN') || amountStr.includes('₦');

  // 2. Delegate to the core offramp handler
  await executeOfframp(conversation, ctx, {
    action: 'OFFRAMP',
    amount: isNaira ? 0 : amount,
    amount_ngn: isNaira ? amount : undefined,
    token: (isNaira ? 'USDC' : tokenStr) as 'USDC' | 'SOL',
    bank_name: '', // Will be prompted in the handler
  }, wallet);
}

export async function sellHandler(ctx: BotContext): Promise<void> {
  await ctx.conversation.enter('sellConversation');
}

/**
 * /receive: Displays user's address and a QR code.
 */
export async function receiveHandler(ctx: BotContext): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await getWallet(telegramId);

  if (!wallet) {
    await ctx.reply('No wallet found. Use /start to set up.');
    return;
  }

  const address = wallet.solana_public_key;
  const qrUrl = `https://quickchart.io/qr?text=${address}&size=300&margin=1`;

  const keyboard = new InlineKeyboard()
    .text('🤫 Generate Stealth Address', 'generate_stealth');

  await ctx.replyWithPhoto(qrUrl, {
    caption:
      `🛡️ *Privacy-Protected Address*\n\n` +
      `Your Solana Address:\n\`${address}\`\n\n` +
      `You can receive SOL and USDC here. Transactions are automatically shielded via *Umbra Privacy* for your security.\n\n` +
      `💡 *Top-Tier Privacy:* Use a "Stealth Address" below to generate a one-time link that leaves no on-chain trace to this wallet.`,
    reply_markup: keyboard,
    parse_mode: 'Markdown',
  });
}

/**
 * Handles generating a one-time stealth address.
 */
export async function generateStealthHandler(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);

  try {
    const stealth = await createStealthReceiver(telegramId);

    await ctx.editMessageCaption({
      caption:
        `🤫 *Stealth Address Generated*\n\n` +
        `This is a temporary, one-time address:\n` +
        `\`${stealth.solana_public_key}\`\n\n` +
        `✅ *How it works:*\n` +
        `1. Give this address to the sender.\n` +
        `2. When funds arrive, our bot detects them.\n` +
        `3. We privately route them to your main wallet using the Umbra Mixer.\n` +
        `4. *No on-chain link* will exist between this address and your main wallet.\n\n` +
        `⏳ _Monitoring active for this address..._`,
      parse_mode: 'Markdown'
    });

    await ctx.answerCallbackQuery('Stealth address generated!');
  } catch (err) {
    console.error(`[stealth] Generation failed:`, err);
    await ctx.answerCallbackQuery('Failed to generate stealth address. Try again later.');
  }
}

// ── /send conversation ────────────────────────────────────────

import { executeTransfer } from '../features/transfer/handler.js';
import { isValidSolanaAddress } from '../utils/helpers.js';

export async function sendConversation(
  conversation: Conversation<BotContext>,
  ctx: BotContext,
): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const wallet = await conversation.external(() => getWallet(telegramId));
  if (!wallet) return;

  // 1. Token Selection
  const tokenKeyboard = new InlineKeyboard()
    .text('USDC', 'send_USDC')
    .text('SOL', 'send_SOL')
    .row()
    .text('❌ Cancel', 'cancel_send');

  await ctx.reply('💸 *Send Crypto*\n\nWhich token would you like to send?', {
    parse_mode: 'Markdown',
    reply_markup: tokenKeyboard
  });

  const callbackCtx = await conversation.waitForCallbackQuery(['send_USDC', 'send_SOL', 'cancel_send']);
  await callbackCtx.answerCallbackQuery();

  if (callbackCtx.callbackQuery.data === 'cancel_send') {
    await ctx.reply('❌ Send cancelled.');
    return;
  }

  const token = callbackCtx.callbackQuery.data.split('_')[1] as 'USDC' | 'SOL';

  // 2. Amount
  await ctx.reply(`💰 *How much ${token} would you like to send?*`, { parse_mode: 'Markdown' });
  let amount: number;
  while (true) {
    const msg = await conversation.waitFor('message:text');
    const input = msg.msg.text.trim().replace(/[^0-9.]/g, '');
    amount = parseFloat(input);
    if (!isNaN(amount) && amount > 0) break;
    await ctx.reply('❌ Invalid amount. Please enter a number (e.g. 10.5):');
  }

  // 3. Recipient Address
  await ctx.reply(`👤 *Enter the recipient's Solana address:*`, { parse_mode: 'Markdown' });
  let recipient: string;
  while (true) {
    const msg = await conversation.waitFor('message:text');
    recipient = msg.msg.text.trim();
    if (isValidSolanaAddress(recipient)) break;
    await ctx.reply('❌ Invalid Solana address. Please try again:');
  }

  // 4. Delegate to the core transfer handler
  await executeTransfer(conversation, ctx, {
    action: 'TRANSFER',
    amount,
    token,
    recipient,
  }, wallet);
}

export async function sendHandler(ctx: BotContext): Promise<void> {
  await ctx.conversation.enter('sendConversation');
}
