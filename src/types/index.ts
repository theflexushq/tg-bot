import { SolanaCluster } from '../config/networks.js';

export interface UserWallet {
  id: string;
  telegram_id: string;
  telegram_username: string | null;
  solana_public_key: string;
  encrypted_private_key: string;
  pin_hash: string | null;
  pin_set: boolean;
  pin_failed_attempts: number;
  pin_locked_until: string | null;
  // Saved Bank Details
  saved_bank_name: string | null;
  saved_account_number: string | null;
  saved_recipient_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: string;
  telegram_id: string;
  solana_tx_signature: string | null;
  action: TransactionAction;
  amount_ngn: number;
  amount_usdc: number;
  amount_sol: number;
  token: 'USDC' | 'SOL';
  phone_number: string | null;
  network: NigerianNetwork | null;
  status: TransactionStatus;
  cluster: SolanaCluster;
  paj_ramp_reference: string | null;
  error_message: string | null;
  // Analytics
  bank_name: string | null;
  recipient_name: string | null;
  recipient_address: string | null;
  bot_message_id: number | null;
  chat_id: number | null;
  created_at: string;
  updated_at: string;
}

export type TransactionAction = 'BUY_AIRTIME' | 'BUY_DATA' | 'PAY_BILL' | 'TRANSFER' | 'OFFRAMP' | 'BUY_USDC' | 'DEPOSIT';
export type TransactionStatus = 'pending' | 'solana_confirmed' | 'paj_triggered' | 'completed' | 'failed' | 'refunded';
export type NigerianNetwork = 'MTN' | 'GLO' | 'AIRTEL' | '9MOBILE';

// ── AI Parsed Intent ──────────────────────────────────────────

export interface AirtimeIntent {
  action: 'BUY_AIRTIME';
  amount_ngn: number;
  phone_number: string;
  network?: NigerianNetwork;
}

export interface DataIntent {
  action: 'BUY_DATA';
  plan_mb: number;          // data in MB e.g. 1024 = 1GB
  amount_ngn: number;
  phone_number: string;
  network?: NigerianNetwork;
}

export interface BillIntent {
  action: 'PAY_BILL';
  bill_type: 'electricity' | 'cable_tv';
  amount_ngn: number;
  account_number: string;
  provider?: string;
}

export interface TransferIntent {
  action: 'TRANSFER';
  amount: number;
  token: 'SOL' | 'USDC';
  recipient: string;
}

export interface OfframpIntent {
  action: 'OFFRAMP';
  amount: number;
  amount_ngn?: number;
  token: 'SOL' | 'USDC';
  bank_name: string;
  account_number?: string;
}

export interface BuyUsdcIntent {
  action: 'BUY_USDC';
  amount: number;
}

export interface DepositIntent {
  action: 'DEPOSIT';
  amount_ngn: number;
}

export interface UnknownIntent {
  action: 'UNKNOWN';
  message: string;          // clarifying question to ask user
}

export type ParsedIntent = AirtimeIntent | DataIntent | BillIntent | TransferIntent | OfframpIntent | BuyUsdcIntent | DepositIntent | UnknownIntent;

// ── Context Extensions ────────────────────────────────────────

export interface SessionData {
  pendingIntent?: ParsedIntent;
  step?: string;
}

// ── paj_ramp ─────────────────────────────────────────────────

export interface PajRampAirtimeRequest {
  phone: string;
  network: NigerianNetwork;
  amount: number;             // NGN
  reference: string;          // unique tx reference
}

export interface PajRampDataRequest {
  phone: string;
  network: NigerianNetwork;
  plan_mb: number;
  reference: string;
}

export interface PajRampResponse {
  success: boolean;
  reference: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface PajRampOfframpRequest {
  amount: number;
  token: 'SOL' | 'USDC';
  bank_name: string;
  account_number: string;
  reference: string;
}

export interface PajRampOnrampRequest {
  amount_usdc: number;
  reference: string;
}

// ── Price ────────────────────────────────────────────────────

export interface PriceQuote {
  ngn_amount: number;
  usdc_amount: number;        // includes fee
  usdc_raw: number;           // before fee
  fee_usdc: number;
  ngn_per_usdc_rate: number;
  fee_percent: number;
}
