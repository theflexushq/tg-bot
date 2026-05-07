// src/services/ai.ts
// REPLACED OpenAI with simple REGEX parsing as requested.

import { ParsedIntent } from '../types/index.js';

/**
 * Parses user free-text into structured intents using Regex.
 * Supported Formats:
 * - Offramp/Sell {amount} {USDC|SOL} to {bank_name}
 * - Buy {amount} USDC
 * - Send {amount} {USDC|SOL} to {address}
 * - Buy {amount} {airtime|data} for {phone} on {network}
 */
export async function parseIntent(userMessage: string): Promise<ParsedIntent> {
  const text = userMessage.trim();

  // 1. Send/Transfer Crypto
  // Format: Send {amount} {SOL/USDC} to {address}
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
  // Format: Offramp/Sell {amount} {USDC|SOL} (to {bank_name})
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
  // Format: Sell {amount} naira (to {bank_name})
  const sellNairaRegex = /^(?:offramp|sell|payout)\s+(?:₦)?(\d+\.?\d*)\s*(?:naira|ngn|₦)(?:\s+to\s+(.+))?$/i;
  const sellNairaMatch = text.match(sellNairaRegex);
  if (sellNairaMatch) {
    return {
      action: 'OFFRAMP',
      amount: 0, // Will be calculated in handler
      amount_ngn: parseFloat(sellNairaMatch[1]),
      token: 'USDC', // Default for Naira offramping
      bank_name: sellNairaMatch[2] ? sellNairaMatch[2].trim() : '',
    };
  }

  // 3. Onramp Crypto
  // Format: Onramp {amount} {USDC|SOL}
  const onrampRegex = /^onramp\s+(\d+\.?\d*)\s*(usdc|sol)$/i;
  const onrampMatch = text.match(onrampRegex);
  if (onrampMatch) {
    return {
      action: 'DEPOSIT',
      amount: parseFloat(onrampMatch[1]),
      token: onrampMatch[2].toUpperCase() as 'SOL' | 'USDC',
    };
  }

  // 4. Deposit
  // Format: Deposit {amount} (naira|usdc|sol)
  const depositNairaRegex = /^deposit\s+(?:₦)?(\d+)(?:\s*naira|ngn|₦)?$/i;
  const depositNairaMatch = text.match(depositNairaRegex);
  if (depositNairaMatch) {
    return {
      action: 'DEPOSIT',
      amount_ngn: parseInt(depositNairaMatch[1]),
    };
  }

  const depositCryptoRegex = /^deposit\s+(\d+\.?\d*)\s*(usdc|sol)$/i;
  const depositCryptoMatch = text.match(depositCryptoRegex);
  if (depositCryptoMatch) {
    return {
      action: 'DEPOSIT',
      amount: parseFloat(depositCryptoMatch[1]),
      token: depositCryptoMatch[2].toUpperCase() as 'SOL' | 'USDC',
    };
  }

  // 5. Buy Airtime/Data (Utility)
  // Format: Buy {amount} airtime/data for {phone}
  const utilityRegex = /^buy\s+(?:₦)?(\d+)\s+(airtime|data)\s+for\s+(\d+)(?:\s+on\s+(mtn|glo|airtel|9mobile))?$/i;
  const utilityMatch = text.match(utilityRegex);
  if (utilityMatch) {
    const amount = parseInt(utilityMatch[1]);
    const type = utilityMatch[2].toLowerCase();
    const phone = utilityMatch[3];
    const network = utilityMatch[4]?.toUpperCase() as any;

    if (type === 'airtime') {
      return {
        action: 'BUY_AIRTIME',
        amount_ngn: amount,
        phone_number: phone,
        network,
      };
    } else {
      return {
        action: 'BUY_DATA',
        plan_mb: amount, // For simplicity, we treat the amount as plan size in MB if data
        amount_ngn: amount,
        phone_number: phone,
        network,
      };
    }
  }

  // Default: Unknown
  return {
    action: 'UNKNOWN',
    message: "I didn't quite catch that. Please use one of these formats:\n\n" +
             "• Onramp 10 USDC / Deposit 1000 Naira\n" +
             "• Send 0.1 SOL to [Address]\n" +
             "• Offramp 10 USDC to [Bank Name]\n" +
             "• Buy 500 airtime for 08012345678",
  };
}
