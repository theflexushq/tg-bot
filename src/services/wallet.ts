// src/services/wallet.ts
// Manages shadow wallets: creation, retrieval, PIN lifecycle.
// Private keys are ONLY decrypted at the moment of signing and never stored elsewhere.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import bcrypt from 'bcryptjs';
import { getSupabase } from './supabase.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { UserWallet } from '../types/index.js';

const BCRYPT_ROUNDS = 12;
const supabase = () => getSupabase();

// ── Create ────────────────────────────────────────────────────

export async function createWallet(
  telegramId: string,
  username: string | null,
): Promise<UserWallet> {
  // Generate a fresh Solana keypair
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  // Encrypt before storing — plaintext key is immediately discarded
  const encryptedPrivateKey = encrypt(privateKeyBase58);

  const { data, error } = await supabase()
    .from('user_wallets')
    .insert({
      telegram_id: telegramId,
      telegram_username: username,
      solana_public_key: publicKey,
      encrypted_private_key: encryptedPrivateKey,
      pin_set: false,
      pin_failed_attempts: 0,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create wallet: ${error.message}`);
  return data as UserWallet;
}

// ── Read ─────────────────────────────────────────────────────

export async function getWallet(telegramId: string): Promise<UserWallet | null> {
  const { data, error } = await supabase()
    .from('user_wallets')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch wallet: ${error.message}`);
  return data as UserWallet | null;
}

// ── Decrypt (signing only) ────────────────────────────────────

/**
 * Returns a Keypair for signing. NEVER store or log the returned keypair.
 * Caller must use it immediately and let it go out of scope.
 */
export function getSigningKeypair(wallet: UserWallet): Keypair {
  const privateKeyBase58 = decrypt(wallet.encrypted_private_key);
  const secretKey = bs58.decode(privateKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

// ── PIN Management ───────────────────────────────────────────

export async function setPin(telegramId: string, pin: string): Promise<void> {
  const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

  const { error } = await supabase()
    .from('user_wallets')
    .update({
      pin_hash: pinHash,
      pin_set: true,
      pin_failed_attempts: 0,
      pin_locked_until: null,
    })
    .eq('telegram_id', telegramId);

  if (error) throw new Error(`Failed to set PIN: ${error.message}`);
}

/**
 * Verifies a PIN. Returns true on success.
 * Handles failed attempt tracking and lockout.
 * Throws on lockout or error.
 */
export async function verifyPin(
  wallet: UserWallet,
  pin: string,
): Promise<{ success: boolean; locked?: boolean; attemptsLeft?: number }> {
  // Check lockout
  if (wallet.pin_locked_until) {
    const lockoutExpiry = new Date(wallet.pin_locked_until);
    if (lockoutExpiry > new Date()) {
      const minutesLeft = Math.ceil((lockoutExpiry.getTime() - Date.now()) / 60000);
      return { success: false, locked: true, attemptsLeft: 0 };
    }
    // Lockout expired — reset
    await resetPinAttempts(wallet.telegram_id);
  }

  if (!wallet.pin_hash) return { success: false };

  const match = await bcrypt.compare(pin, wallet.pin_hash);

  if (match) {
    await resetPinAttempts(wallet.telegram_id);
    return { success: true };
  }

  // Increment failed attempts
  const maxAttempts = parseInt(process.env.MAX_PIN_ATTEMPTS ?? '3');
  const newAttempts = wallet.pin_failed_attempts + 1;

  if (newAttempts >= maxAttempts) {
    const lockoutMinutes = parseInt(process.env.PIN_LOCKOUT_MINUTES ?? '15');
    const lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString();

    await supabase()
      .from('user_wallets')
      .update({ pin_failed_attempts: newAttempts, pin_locked_until: lockedUntil })
      .eq('telegram_id', wallet.telegram_id);

    return { success: false, locked: true, attemptsLeft: 0 };
  }

  await supabase()
    .from('user_wallets')
    .update({ pin_failed_attempts: newAttempts })
    .eq('telegram_id', wallet.telegram_id);

  return { success: false, attemptsLeft: maxAttempts - newAttempts };
}

async function resetPinAttempts(telegramId: string): Promise<void> {
  await supabase()
    .from('user_wallets')
    .update({ pin_failed_attempts: 0, pin_locked_until: null })
    .eq('telegram_id', telegramId);
}

export async function isPinLocked(wallet: UserWallet): Promise<{ locked: boolean; minutesLeft?: number }> {
  if (!wallet.pin_locked_until) return { locked: false };
  const expiry = new Date(wallet.pin_locked_until);
  if (expiry <= new Date()) return { locked: false };
  const minutesLeft = Math.ceil((expiry.getTime() - Date.now()) / 60000);
  return { locked: true, minutesLeft };
}

export async function saveBankDetails(
  telegramId: string,
  bankName: string,
  accountNumber: string,
  recipientName: string,
): Promise<void> {
  const { error } = await supabase()
    .from('user_wallets')
    .update({
      saved_bank_name: bankName,
      saved_account_number: accountNumber,
      saved_recipient_name: recipientName,
    })
    .eq('telegram_id', telegramId);

  if (error) throw new Error(`Failed to save bank details: ${error.message}`);
}
