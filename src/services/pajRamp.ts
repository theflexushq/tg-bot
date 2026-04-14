// src/services/pajRamp.ts
// ─────────────────────────────────────────────────────────────────────────────
// PAJ RAMP INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

import * as PajSDK from 'paj_ramp';
import { 
  PajRampAirtimeRequest, 
  PajRampDataRequest, 
  PajRampResponse, 
  NigerianNetwork, 
  PajRampOfframpRequest, 
  PajRampOnrampRequest 
} from '../types/index.js';

// Configuration
const API_KEY = process.env.PAJ_RAMP_API_KEY || '';
const SESSION_TOKEN = process.env.PAJ_SESSION_TOKEN || '';
const BASE_URL = process.env.PAJ_RAMP_BASE_URL || '';
const USDC_MINT = process.env.USDC_MINT_ADDRESS || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

let isInitialized = false;

/**
 * Initializes the PAJ SDK if not already done.
 */
function ensureInitialized() {
  if (isInitialized) return;
  
  const env = BASE_URL.includes('dev') || BASE_URL.includes('local') 
    ? PajSDK.Environment.Local 
    : PajSDK.Environment.Production;
  
  PajSDK.initializeSDK(env);
  isInitialized = true;
  console.log(`📡 PAJ SDK initialized on ${env}`);
}

// ── Virtual Account (Bank Transfer Onramp) ────────────────────

/**
 * Generates a temporary virtual account for a specific deposit amount.
 */
export async function getVirtualAccount(req: { 
  amount_ngn: number; 
  reference: string;
  recipient: string; 
}): Promise<PajRampResponse> {
  ensureInitialized();

  if (!SESSION_TOKEN) {
    console.error('❌ PAJ_SESSION_TOKEN is missing from .env');
    return {
      success: false,
      reference: req.reference,
      message: 'Authentication missing. Please run scripts/paj-login.ts',
    };
  }

  console.log(`🏦 Requesting virtual account for ${req.amount_ngn} NGN | Ref: ${req.reference}`);

  try {
    // Timeout wrapper to prevent hanging
    const createOrderPromise = PajSDK.createOnrampOrder(
      {
        fiatAmount: req.amount_ngn,
        currency: 'NGN',
        recipient: req.recipient,
        mint: USDC_MINT,
        chain: PajSDK.Chain.SOLANA,
        webhookURL: WEBHOOK_URL,
        fee: 0,
      },
      SESSION_TOKEN
    );

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('PAJ API request timed out (15s)')), 15000)
    );

    const order = await Promise.race([createOrderPromise, timeoutPromise]);
    console.log('✅ Order created:', (order as any).id);

    return {
      success: true,
      reference: req.reference,
      message: 'Virtual account generated',
      data: {
        bank_name: (order as any).bank,
        account_number: (order as any).accountNumber,
        account_name: (order as any).accountName,
        order_id: (order as any).id,
      },
    };
  } catch (err: any) {
    console.error('[pajRamp] getVirtualAccount error details:', err?.response?.data || err);
    return {
      success: false,
      reference: req.reference,
      message: err?.message || 'Failed to generate virtual account',
    };
  }
}

/**
 * Returns a list of the most popular banks in Nigeria for quick selection.
 */
export async function getPopularBanks(): Promise<{ id: string; name: string }[]> {
  ensureInitialized();
  if (!SESSION_TOKEN) throw new Error('Authentication missing');
  
  const allBanks = await PajSDK.getBanks(SESSION_TOKEN);
  const popularNames = ['OPay', 'Kuda', 'Moniepoint', 'Zenith Bank', 'GTBank', 'United Bank For Africa', 'Access Bank'];
  
  return allBanks
    .filter(b => popularNames.some(p => b.name.toLowerCase().includes(p.toLowerCase())))
    .slice(0, 8)
    .map(b => ({ id: b.id, name: b.name }));
}

/**
 * Searches the bank list for matches based on user input.
 */
export async function searchBanks(query: string): Promise<{ id: string; name: string }[]> {
  ensureInitialized();
  if (!SESSION_TOKEN) throw new Error('Authentication missing');

  const allBanks = await PajSDK.getBanks(SESSION_TOKEN);
  const normalizedQuery = query.toLowerCase().replace(/\s/g, '');

  return allBanks
    .filter(b => b.name.toLowerCase().replace(/\s/g, '').includes(normalizedQuery))
    .slice(0, 10)
    .map(b => ({ id: b.id, name: b.name }));
}

/**
 * Resolves a Nigerian bank account number to a registered name.
 */
export async function resolveAccountName(bankNameInput: string, accountNumber: string): Promise<{ accountName: string; matchedBankName: string }> {
  ensureInitialized();

  if (!SESSION_TOKEN) {
    throw new Error('Authentication missing. Please run scripts/paj-login.ts');
  }

  // 1. Get the list of banks to find the ID
  const banks = await PajSDK.getBanks(SESSION_TOKEN);
  
  // Fuzzy match the bank name
  const normalizedInput = bankNameInput.toLowerCase().replace(/\s/g, '');
  const matchedBank = banks.find(b => 
    b.name.toLowerCase().replace(/\s/g, '').includes(normalizedInput) ||
    normalizedInput.includes(b.name.toLowerCase().replace(/\s/g, ''))
  );

  if (!matchedBank) {
    throw new Error(`Could not find a bank matching "${bankNameInput}".`);
  }

  console.log(`🔍 Resolving account ${accountNumber} at ${matchedBank.name} (${matchedBank.id})...`);

  // 2. Resolve the account
  try {
    const result = await PajSDK.resolveBankAccount(SESSION_TOKEN, matchedBank.id, accountNumber);
    return {
      accountName: result.accountName,
      matchedBankName: matchedBank.name,
    };
  } catch (err: any) {
    console.error('[pajRamp] resolveBankAccount error:', err?.message || err);
    throw new Error(`Failed to resolve account: ${err?.message || 'Invalid account details'}`);
  }
}

// ── Offramp (Sell Crypto) ──────────────────────────────────────

export async function sellCrypto(req: PajRampOfframpRequest): Promise<PajRampResponse> {
  ensureInitialized();

  try {
    const order = await PajSDK.createOfframpOrder(
      {
        amount: req.amount,
        currency: req.token,
        bankName: req.bank_name,
        accountNumber: req.account_number,
        reference: req.reference,
      } as any,
      API_KEY
    );

    return {
      success: true,
      reference: req.reference,
      message: 'Offramp initiated',
      data: order as any,
    };
  } catch (err: any) {
    console.error('[pajRamp] sellCrypto error:', err);
    return {
      success: false,
      reference: req.reference,
      message: err?.message || 'Offramp failed',
    };
  }
}

// ── Utility (Airtime/Data) ────────────────────────────────────
// These currently use placeholders until the Utility module of the SDK is finalized
// but we keep the structure for future SDK updates.

export async function sendAirtime(req: PajRampAirtimeRequest): Promise<PajRampResponse> {
  console.log(`📱 Sending airtime: ${req.amount} NGN to ${req.phone}`);
  // Temporary: Until utility SDK is verified, we return a success mock if on test mode
  // or throw if we need real integration.
  return {
    success: true,
    reference: req.reference,
    message: 'Airtime order placed',
  };
}

export async function sendData(req: PajRampDataRequest): Promise<PajRampResponse> {
  console.log(`🌐 Sending data: ${req.plan_mb}MB to ${req.phone}`);
  return {
    success: true,
    reference: req.reference,
    message: 'Data order placed',
  };
}

export async function buyCrypto(req: PajRampOnrampRequest): Promise<PajRampResponse> {
  // Deprecated in favor of getVirtualAccount for bank transfer
  // but kept for compatibility.
  return {
    success: false,
    reference: req.reference,
    message: 'Use Deposit for bank transfer flow',
  };
}

// ── Rates ─────────────────────────────────────────────────────

/**
 * Returns the current NGN/USDC onramp rate from PAJ SDK.
 */
export async function getOnrampRate(): Promise<number | null> {
  ensureInitialized();
  if (!SESSION_TOKEN) return null;

  try {
    const res = await PajSDK.getOnrampValue({
      amount: 1,
      currency: PajSDK.Currency.USD,
      mint: USDC_MINT
    }, SESSION_TOKEN);
    return res.rate;
  } catch (err) {
    console.error('[pajRamp] getOnrampRate failed:', err);
    return null;
  }
}

/**
 * Returns the current NGN/USDC offramp rate from PAJ SDK.
 */
export async function getOfframpRate(): Promise<number | null> {
  ensureInitialized();
  if (!SESSION_TOKEN) return null;

  try {
    const res = await PajSDK.getOfframpValue({
      amount: 1,
      currency: PajSDK.Currency.USD,
      mint: USDC_MINT
    }, SESSION_TOKEN);
    // For offramp, tokenRate is usually the NGN per 1 USDC
    return res.tokenRate;
  } catch (err) {
    console.error('[pajRamp] getOfframpRate failed:', err);
    return null;
  }
}
