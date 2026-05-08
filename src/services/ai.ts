// src/services/ai.ts
// Uses Groq (Llama 3.3) via OpenAI Compatibility Layer
// Fallback: Simple Regex parsing for reliability.

import OpenAI from 'openai';
import { ParsedIntent, NigerianNetwork } from '../types/index.js';

// Groq is OpenAI-compatible. We use the existing OpenAI SDK pointed at Groq's endpoint.
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

/**
 * Parses user free-text into structured intents using Groq (LLM) with a Regex fallback.
 */
export async function parseIntent(userMessage: string): Promise<ParsedIntent> {
  const text = userMessage.trim();

  try {
    // 1. Attempt LLM Parsing (Groq)
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are a financial assistant for a Solana Telegram bot in Nigeria. 
Extract structured data from the user's message and return ONLY a valid JSON object.

Intent Types:
- TRANSFER: Sending tokens to an address.
- OFFRAMP: Selling tokens for Naira to a bank account.
- DEPOSIT: Buying tokens with Naira.
- BUY_AIRTIME/BUY_DATA: Mobile top-ups.
- BALANCE: User wants to check their balance.
- WALLET: User wants their public address/QR code.
- HISTORY: User wants to see recent transactions.
- HELP: User needs instructions.
- PROFILE: User wants to see their stats/saved bank.
- CANCEL: User wants to stop the current process or transaction.

JSON Schema:
1. { "action": "TRANSFER", "amount": number, "token": "SOL"|"USDC", "recipient": string }
2. { "action": "OFFRAMP", "amount": number, "token": "SOL"|"USDC", "bank_name": string }
3. { "action": "DEPOSIT", "amount_ngn"?: number, "amount"?: number, "token"?: "USDC"|"SOL" }
4. { "action": "BUY_AIRTIME", "amount_ngn": number, "phone_number": string }
5. { "action": "BALANCE" | "WALLET" | "HISTORY" | "HELP" | "PROFILE" | "CANCEL" }
6. { "action": "UNKNOWN", "message": "Helpful response" }

Guidelines:
- If they say "cancel", "stop", "nevermind", or "abort", return { "action": "CANCEL" }.
- If they say "1 usdc" or "0.1 sol", use "amount".
- If they say "1000 naira" or "₦5000", use "amount_ngn".
- "Buy" or "Onramp" usually means DEPOSIT.
- If they ask "What is my balance?" or "How much do I have?", return { "action": "BALANCE" }.
- If they ask for their address or QR code, return { "action": "WALLET" }.`,
        },
        {
          role: 'user',
          content: text,
        },
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = completion.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content) as ParsedIntent;
      if (parsed.action && parsed.action !== 'UNKNOWN') {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[ai:groq] LLM parsing failed, falling back to Regex:', err);
  }

  // 2. Fallback to Regex
  return parseIntentWithRegex(text);
}

function parseIntentWithRegex(text: string): ParsedIntent {
  // 1. Send/Transfer Crypto
  const sendRegex = /^(?:send|transfer)\s+(\d+\.?\d*)\s*(sol|usdc)\s+(?:to\s+)?([a-zA-Z0-9]+)$/i;
  const sendMatch = text.match(sendRegex);
  if (sendMatch) {
    return {
      action: 'TRANSFER',
      amount: parseFloat(sendMatch[1]),
      token: sendMatch[2].toUpperCase() as 'SOL' | 'USDC',
      recipient: sendMatch[3],
    };
  }

  // 2. Offramp/Sell
  const sellRegex = /^(?:offramp|sell|payout)\s+(\d+\.?\d*)\s*(usdc|sol)(?:\s+to\s+(.+))?$/i;
  const sellMatch = text.match(sellRegex);
  if (sellMatch) {
    return {
      action: 'OFFRAMP',
      amount: parseFloat(sellMatch[1]),
      token: sellMatch[2].toUpperCase() as 'SOL' | 'USDC',
      bank_name: sellMatch[3] ? sellMatch[3].trim() : '',
    };
  }

  // 2b. Offramp/Sell (Naira based)
  const sellNairaRegex = /^(?:offramp|sell|payout)\s+(?:₦)?(\d+\.?\d*)\s*(?:naira|ngn|₦)(?:\s+to\s+(.+))?$/i;
  const sellNairaMatch = text.match(sellNairaRegex);
  if (sellNairaMatch) {
    return {
      action: 'OFFRAMP',
      amount: 0,
      amount_ngn: parseFloat(sellNairaMatch[1]),
      token: 'USDC',
      bank_name: sellNairaMatch[2] ? sellNairaMatch[2].trim() : '',
    };
  }

  // 3. Deposit/Onramp
  const depositNairaRegex = /^(?:deposit|onramp|buy)\s+(?:₦)?(\d+)(?:\s*naira|ngn|₦)?$/i;
  const depositNairaMatch = text.match(depositNairaRegex);
  if (depositNairaMatch) {
    return { action: 'DEPOSIT', amount_ngn: parseInt(depositNairaMatch[1]) };
  }

  const depositCryptoRegex = /^(?:deposit|onramp|buy)\s+(\d+\.?\d*)\s*(usdc|sol)$/i;
  const depositCryptoMatch = text.match(depositCryptoRegex);
  if (depositCryptoMatch) {
    return {
      action: 'DEPOSIT',
      amount: parseFloat(depositCryptoMatch[1]),
      token: depositCryptoMatch[2].toUpperCase() as 'SOL' | 'USDC',
    };
  }

  // 4. Utility (Airtime/Data)
  const utilityRegex = /^buy\s+(?:₦)?(\d+)\s+(airtime|data)\s+for\s+(\d+)(?:\s+on\s+(mtn|glo|airtel|9mobile))?$/i;
  const utilityMatch = text.match(utilityRegex);
  if (utilityMatch) {
    const amount = parseInt(utilityMatch[1]);
    const type = utilityMatch[2].toLowerCase();
    const phone = utilityMatch[3];
    const network = utilityMatch[4]?.toUpperCase() as NigerianNetwork;

    if (type === 'airtime') {
      return { action: 'BUY_AIRTIME', amount_ngn: amount, phone_number: phone, network };
    } else {
      return { action: 'BUY_DATA', plan_mb: amount, amount_ngn: amount, phone_number: phone, network };
    }
  }

  return {
    action: 'UNKNOWN',
    message: "I didn't quite catch that. Try commands like:\n" +
             "• Buy 10 USDC\n" +
             "• Send 0.1 SOL to [Address]\n" +
             "• Sell 5000 Naira to Kuda\n" +
             "• Buy 500 airtime for 08012345678",
  };
}
