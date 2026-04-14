// src/index.ts
// Bot entry point. Registers all middleware, conversations, and handlers.

import 'dotenv/config';
import { Bot, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';

import { BotContext, SessionData, initialSession } from './types/context.js';
import { startHandler, setupPinConversation } from './handlers/start.js';
import { handleUserMessage, purchaseFlowConversation } from './handlers/purchase.js';
import {
  balanceHandler,
  walletHandler,
  historyHandler,
  helpHandler,
  changePinConversation,
  exportConversation,
  exportHandler,
  depositConversation,
  depositHandler,
  sellConversation,
  sellHandler,
  profileHandler,
} from './handlers/commands.js';
import { addBankConversation } from './features/offramp/addBank.js';
import { startTransactionWatcher } from './services/watcher.js';

// ── Validate env ──────────────────────────────────────────────

const requiredEnv = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'OPENAI_API_KEY',
  'TREASURY_WALLET_PUBLIC_KEY',
  'USDC_MINT_ADDRESS',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ── Bot setup ─────────────────────────────────────────────────

const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);

// Session middleware (in-memory — swap for Redis/Supabase in production)
bot.use(
  session<SessionData, BotContext>({
    initial: initialSession,
  }),
);

// Conversation middleware (must come after session)
bot.use(conversations<BotContext>());

// Register conversations
bot.use(createConversation(setupPinConversation, 'setupPin'));
bot.use(createConversation(purchaseFlowConversation, 'purchaseFlow'));
bot.use(createConversation(changePinConversation, 'changePin'));
bot.use(createConversation(exportConversation, 'exportConversation'));
bot.use(createConversation(depositConversation, 'depositConversation'));
bot.use(createConversation(sellConversation, 'sellConversation'));
bot.use(createConversation(addBankConversation, 'addBankConversation'));

// ── Commands ──────────────────────────────────────────────────

bot.command('start', startHandler);
bot.command('balance', balanceHandler);
bot.command('wallet', walletHandler);
bot.command('history', historyHandler);
bot.command('help', helpHandler);
bot.command('changepin', async (ctx) => {
  await ctx.conversation.enter('changePin');
});
bot.command('export', exportHandler);
bot.command('deposit', depositHandler);
bot.command('sell', sellHandler);
bot.command('profile', profileHandler);
bot.on('message:text', async (ctx, next) => {
  if (ctx.message.text.toLowerCase() === 'profile') {
    return profileHandler(ctx);
  }
  return next();
});
bot.command('addbank', async (ctx) => {
  await ctx.conversation.enter('addBankConversation');
});

// ── Callbacks ────────────────────────────────────────────────
bot.callbackQuery('delete_this_msg', async (ctx) => {
  try {
    if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message!.message_id);
    await ctx.answerCallbackQuery('Message deleted for security.');
  } catch (err) {
    await ctx.answerCallbackQuery('Could not delete message. Please delete it manually.');
  }
});

// ── Message handler ───────────────────────────────────────────
// Any non-command text message goes through AI parsing

bot.on('message:text', async (ctx) => {
  // Skip messages that are commands
  if (ctx.message.text.startsWith('/')) return;
  await handleUserMessage(ctx);
});

// ── Error handler ─────────────────────────────────────────────

bot.catch((err) => {
  console.error('[bot] Unhandled error:', err);
});

// ── Launch ────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Starting Solana Telegram bot...');
  startTransactionWatcher(bot);

  // Set bot commands menu in Telegram
  await bot.api.setMyCommands([
    { command: 'start', description: 'Set up or view your wallet' },
    { command: 'balance', description: 'Check your USDC balance' },
    { command: 'wallet', description: 'View your deposit address' },
    { command: 'history', description: 'Recent transactions' },
    { command: 'changepin', description: 'Change your PIN' },
    { command: 'export', description: 'Export your Private Key (Secret)' },
    { command: 'deposit', description: 'Fund your wallet with Naira' },
    { command: 'sell', description: 'Sell crypto for Naira (Offramp)' },
    { command: 'profile', description: 'View your bank and transaction stats' },
    { command: 'addbank', description: 'Save your bank for fast payouts' },
    { command: 'help', description: 'How to use this bot' },
  ]);

  await bot.start({
    onStart: (info) => console.log(`✅ Bot running as @${info.username}`),
  });
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
