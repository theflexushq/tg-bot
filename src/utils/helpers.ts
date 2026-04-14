// src/utils/helpers.ts

import { NigerianNetwork } from '../types/index.js';

/**
 * Normalises a Nigerian phone number to 11-digit local format.
 * Accepts: 080..., +23480..., 23480...
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) {
    return '0' + digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return digits;
  }
  throw new Error(`Invalid Nigerian phone number: ${raw}`);
}

/**
 * Detects Nigerian network from prefix.
 */
export function detectNetwork(phone: string): NigerianNetwork {
  const normalised = normalisePhone(phone);
  const prefix = normalised.slice(0, 4);

  const mtn = ['0703','0706','0803','0806','0810','0813','0814','0816','0903','0906','0913','0916'];
  const glo = ['0705','0805','0807','0811','0815','0905'];
  const airtel = ['0701','0708','0802','0808','0812','0902','0907','0901'];
  const mobile9 = ['0809','0817','0818','0908','0909'];

  if (mtn.includes(prefix)) return 'MTN';
  if (glo.includes(prefix)) return 'GLO';
  if (airtel.includes(prefix)) return 'AIRTEL';
  if (mobile9.includes(prefix)) return '9MOBILE';

  // fallback — MTN is most common
  return 'MTN';
}

/**
 * Formats USDC amount for display (6 decimal places → 2 d.p.)
 */
export function formatUSDC(amount: number): string {
  return amount.toFixed(4);
}

/**
 * Formats NGN amount with comma separator.
 */
export function formatNGN(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}

/**
 * Returns a short version of a Solana address for display.
 * e.g. "EPjFW...Dt1v"
 */
export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

/**
 * Escapes MarkdownV2 special characters for Telegram messages.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Validates that a string looks like a 4-digit PIN.
 */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

/**
 * Validates a Solana address.
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    const { PublicKey } = require('@solana/web3.js');
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleeps for N milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
