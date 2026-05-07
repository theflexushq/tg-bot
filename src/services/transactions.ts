// src/services/transactions.ts
// Records every transaction attempt, Solana confirmation, and paj_ramp result.

import { getSupabase } from './supabase.js';
import { Transaction, TransactionAction, TransactionStatus, NigerianNetwork } from '../types/index.js';
import { SolanaCluster } from '../config/networks.js';

const db = () => getSupabase();

export async function createTransaction(params: {
  telegramId: string;
  action: TransactionAction;
  amountNgn: number;
  amountUsdc: number;
  amountSol?: number;
  token?: 'USDC' | 'SOL';
  cluster?: SolanaCluster;
  phoneNumber?: string;
  network?: NigerianNetwork;
  // Analytics
  bankName?: string;
  recipientName?: string;
  recipientAddress?: string;
  isStealth?: boolean;
}): Promise<Transaction> {
  const { data, error } = await db()
    .from('transactions')
    .insert({
      telegram_id: params.telegramId,
      action: params.action,
      amount_ngn: params.amountNgn,
      amount_usdc: params.amountUsdc,
      amount_sol: params.amountSol ?? 0,
      token: params.token ?? 'USDC',
      cluster: params.cluster ?? 'mainnet-beta',
      phone_number: params.phoneNumber ?? null,
      network: params.network ?? null,
      bank_name: params.bankName ?? null,
      recipient_name: params.recipientName ?? null,
      recipient_address: params.recipientAddress ?? null,
      is_stealth: params.isStealth ?? false,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create transaction: ${error.message}`);
  return data as Transaction;
}

export async function updateTransaction(
  id: string,
  updates: Partial<{
    status: TransactionStatus;
    solanaTxSignature: string | null;
    pajRampReference: string | null;
    errorMessage: string | null;
    botMessageId: number;
    chatId: number;
    isStealth: boolean;
  }>,
): Promise<void> {
  const mapped: Record<string, unknown> = {};
  if (updates.status) mapped.status = updates.status;
  if (updates.solanaTxSignature) mapped.solana_tx_signature = updates.solanaTxSignature;
  if (updates.pajRampReference) mapped.paj_ramp_reference = updates.pajRampReference;
  if (updates.errorMessage !== undefined) mapped.error_message = updates.errorMessage;
  if (updates.botMessageId !== undefined) mapped.bot_message_id = updates.botMessageId;
  if (updates.chatId !== undefined) mapped.chat_id = updates.chatId;
  if (updates.isStealth !== undefined) mapped.is_stealth = updates.isStealth;

  const { error } = await db()
    .from('transactions')
    .update(mapped)
    .eq('id', id);

  if (error) throw new Error(`Failed to update transaction: ${error.message}`);
}

export async function getTransactionHistory(
  telegramId: string,
  limit = 5,
): Promise<Transaction[]> {
  const { data, error } = await db()
    .from('transactions')
    .select('*')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch transactions: ${error.message}`);
  return data as Transaction[];
}

export async function getTransactionStats(telegramId: string): Promise<Record<string, number>> {
  const { data, error } = await db()
    .from('transactions')
    .select('action')
    .eq('telegram_id', telegramId);

  if (error) throw new Error(`Failed to fetch stats: ${error.message}`);

  const stats: Record<string, number> = {};
  data.forEach((tx: any) => {
    stats[tx.action] = (stats[tx.action] || 0) + 1;
  });

  return stats;
}

export async function cleanupExpiredTransactions(minutes = 15): Promise<Transaction[]> {
  const expiryTime = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // 1. Find pending onramps older than X minutes
  const { data, error } = await db()
    .from('transactions')
    .update({ 
      status: 'failed', 
      error_message: 'Expired: Payment not received within 15 minutes' 
    })
    .eq('status', 'pending')
    .in('action', ['DEPOSIT', 'BUY_USDC'])
    .lt('created_at', expiryTime)
    .select();

  if (error) {
    console.error('[transactions] Cleanup failed:', error.message);
    return [];
  }

  return (data as Transaction[]) || [];
}
