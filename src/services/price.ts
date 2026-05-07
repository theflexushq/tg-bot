// src/services/price.ts
// Fetches live NGN/USDC and NGN/SOL exchange rates.
// PAJ SDK only supports USDC rate natively. SOL price is fetched from CoinGecko.

import axios from 'axios';
import { PriceQuote } from '../types/index.js';
import { getOnrampRate, getOfframpRate } from './pajRamp.js';

// ── Constants ─────────────────────────────────────────────────
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = process.env.USDC_MINT_ADDRESS || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── In-memory caches ──────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedUsdcNgn: number | null = null;
let cachedUsdcTimestamp = 0;

let cachedSolUsd: number | null = null;
let cachedSolTimestamp = 0;

// ── USDC Rate (PAJ SDK) ───────────────────────────────────────

/**
 * Returns NGN per 1 USDC using PAJ SDK (most accurate for onramp/offramp).
 * NOTE: PAJ SDK only natively supports USDC — do NOT pass SOL mint here.
 */
async function fetchUsdcNgnRate(type: 'onramp' | 'offramp' = 'onramp'): Promise<number> {
  const now = Date.now();
  if (cachedUsdcNgn && now - cachedUsdcTimestamp < CACHE_TTL_MS) return cachedUsdcNgn;

  try {
    const pajRate = type === 'onramp' ? await getOnrampRate() : await getOfframpRate();
    if (pajRate && pajRate > 100) { // sanity check: must be plausible NGN rate
      cachedUsdcNgn = pajRate;
      cachedUsdcTimestamp = now;
      return pajRate;
    }
  } catch (err) {
    console.error('[price] PAJ USDC rate fetch failed:', err);
  }

  // Fallback: public exchange rate API
  try {
    const apiKey = process.env.RATE_API_KEY;
    const url = apiKey
      ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
      : 'https://open.er-api.com/v6/latest/USD';
    const response = await axios.get(url, { timeout: 5000 });
    const ngnRate = response.data?.rates?.NGN as number | undefined;
    if (ngnRate) {
      cachedUsdcNgn = ngnRate;
      cachedUsdcTimestamp = now;
      return ngnRate;
    }
  } catch (err) {
    console.error('[price] Fallback rate fetch failed:', err);
  }

  return cachedUsdcNgn ?? 1600;
}

// ── SOL Rate (CoinGecko → NGN) ────────────────────────────────

/**
 * Returns NGN per 1 SOL.
 * Strategy: Fetch SOL/USD from CoinGecko, then multiply by NGN/USD (PAJ rate).
 * This is needed because the PAJ SDK only supports USDC and ignores other mints.
 */
async function fetchSolNgnRate(): Promise<number> {
  const now = Date.now();

  // Serve from cache if fresh
  if (cachedSolUsd && now - cachedSolTimestamp < CACHE_TTL_MS) {
    const ngnPerUsd = await fetchUsdcNgnRate();
    return cachedSolUsd * ngnPerUsd;
  }

  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    const solUsd = res.data?.solana?.usd as number | undefined;
    if (solUsd && solUsd > 1) {
      cachedSolUsd = solUsd;
      cachedSolTimestamp = now;
      console.log(`[price] Live SOL price: $${solUsd}`);
      const ngnPerUsd = await fetchUsdcNgnRate();
      return solUsd * ngnPerUsd;
    }
  } catch (err) {
    console.error('[price] CoinGecko SOL fetch failed:', err);
  }

  // Fallback: use cached SOL price or rough estimate ($140)
  const ngnPerUsd = await fetchUsdcNgnRate();
  return (cachedSolUsd ?? 140) * ngnPerUsd;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Returns NGN per 1 unit of a given token (USDC or SOL).
 * - USDC: uses PAJ SDK (matches dashboard rate)
 * - SOL:  uses CoinGecko USD price × PAJ NGN/USD rate
 */
export async function getNgnPerCrypto(token: 'USDC' | 'SOL', type: 'onramp' | 'offramp' = 'onramp'): Promise<number> {
  if (token === 'SOL') {
    return fetchSolNgnRate();
  }
  return fetchUsdcNgnRate(type);
}

/**
 * Returns NGN per 1 USDC (legacy compatibility).
 */
export async function getNgnPerUsdc(type: 'onramp' | 'offramp' = 'onramp'): Promise<number> {
  return fetchUsdcNgnRate(type);
}

/**
 * Calculates how much Naira is needed to receive a target amount of any supported token.
 */
export async function calculateNgnForCrypto(targetAmount: number, token: 'USDC' | 'SOL'): Promise<number> {
  const rate = await getNgnPerCrypto(token, 'onramp');
  const feePct = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5');
  const ngnRequired = (targetAmount / (1 - feePct / 100)) * rate;
  return Math.ceil(ngnRequired);
}

/**
 * Calculates how much Naira is needed to receive a target USDC amount (legacy compatibility).
 */
export async function calculateNgnForUsdc(targetUsdc: number): Promise<number> {
  return calculateNgnForCrypto(targetUsdc, 'USDC');
}

/**
 * Builds a full price quote for an NGN amount.
 * Used for OFFRAMP (Selling USDC for Naira).
 */
export async function buildQuote(ngnAmount: number): Promise<PriceQuote> {
  const rate = await fetchUsdcNgnRate('offramp');
  const feePct = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.5');

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
