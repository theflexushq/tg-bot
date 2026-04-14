// src/services/price.ts
// Fetches live NGN/USDC exchange rate and builds price quotes.
// Falls back to a cached rate if the API is unavailable.

import axios from 'axios';
import { PriceQuote } from '../types/index.js';

// Simple in-memory cache
let cachedRate: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

import { getOnrampRate, getOfframpRate } from './pajRamp.js';

/**
 * Returns NGN per 1 USDC.
 * Prioritizes PAJ SDK rates to match dashboard.
 */
export async function getNgnPerUsdc(type: 'onramp' | 'offramp' = 'onramp'): Promise<number> {
  const now = Date.now();
  
  // Try PAJ SDK first
  try {
    const pajRate = type === 'onramp' ? await getOnrampRate() : await getOfframpRate();
    if (pajRate) {
      cachedRate = pajRate;
      cacheTimestamp = now;
      return pajRate;
    }
  } catch (err) {
    console.error(`[price] PAJ ${type} rate fetch failed:`, err);
  }

  if (cachedRate && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRate;
  }

  try {
    // Fallback: ExchangeRate-API
    const apiKey = process.env.RATE_API_KEY;
    const url = apiKey
      ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
      : 'https://open.er-api.com/v6/latest/USD';

    const response = await axios.get(url, { timeout: 5000 });
    const ngnRate = response.data?.rates?.NGN as number | undefined;

    if (!ngnRate) throw new Error('NGN rate not found in response');

    cachedRate = ngnRate;
    cacheTimestamp = now;
    return ngnRate;
  } catch (err) {
    console.error('[price] Rate fetch failed, using fallback:', err);
    return cachedRate ?? 1600;
  }
}

/**
 * Builds a full price quote for an NGN amount.
 * Used for OFFRAMP (Selling USDC for Naira).
 */
export async function buildQuote(ngnAmount: number): Promise<PriceQuote> {
  const rate = await getNgnPerUsdc('offramp');
  const feePct = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5');

  // For Selling: User provides NGN amount they want to see? 
  // Usually user specifies USDC. If they specify NGN:
  // NGN = (USDC * Rate) * (1 - fee)
  // USDC = NGN / (Rate * (1 - fee))
  const usdcRaw = ngnAmount / rate;
  const usdcTotal = usdcRaw / (1 - feePct / 100);
  const feeUsdc = usdcTotal - usdcRaw;

  return {
    ngn_amount: ngnAmount,
    usdc_amount: parseFloat(usdcTotal.toFixed(6)),
    usdc_raw: parseFloat(usdcRaw.toFixed(6)),
    fee_usdc: parseFloat(feeUsdc.toFixed(6)),
    ngn_per_usdc_rate: rate,
    fee_percent: feePct,
  };
}

/**
 * Calculates how much Naira is needed to receive a target USDC amount.
 * Used for ONRAMP (Buying USDC with Naira).
 */
export async function calculateNgnForUsdc(targetUsdc: number): Promise<number> {
  const rate = await getNgnPerUsdc('onramp');
  const feePct = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5');
  
  // Naira = (USDC / (1 - fee)) * Rate
  // This ensures that after the fee is taken, the user has exactly targetUsdc.
  const ngnRequired = (targetUsdc / (1 - feePct / 100)) * rate;
  return Math.ceil(ngnRequired);
}

/**
 * Formats a quote into a human-readable Telegram message block.
 */
export function formatQuote(quote: PriceQuote): string {
  return (
    `💱 *Rate:* ₦${quote.ngn_per_usdc_rate.toLocaleString('en-NG')} / USDC\n` +
    `💵 *Amount:* ₦${quote.ngn_amount.toLocaleString('en-NG')}\n` +
    `⚡ *Cost:* ${quote.usdc_raw.toFixed(4)} USDC\n` +
    `🏦 *Fee (${quote.fee_percent}%):* ${quote.fee_usdc.toFixed(4)} USDC\n` +
    `✅ *Total deducted:* ${quote.usdc_amount.toFixed(4)} USDC`
  );
}
