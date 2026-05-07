// src/services/solana.ts
// Handles USDC transfers from user shadow wallets to treasury.
// Never logs or persists keypairs — they exist only for the duration of the signing call.

import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  Commitment,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { UserWallet } from '../types/index.js';
import { getSigningKeypair } from './wallet.js';

import { SolanaCluster } from '../config/networks.js';

// USDC decimals
const USDC_DECIMALS = 6;

// Predefined RPC URLs
const RPC_URLS: Record<SolanaCluster, string> = {
  'mainnet-beta': process.env.SOLANA_MAINNET_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  'devnet': process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
};

const connections: Partial<Record<SolanaCluster, Connection>> = {};

/**
 * Gets or creates a connection for a specific Solana cluster.
 */
export function getConnection(cluster: SolanaCluster = 'devnet'): Connection {
  if (connections[cluster]) return connections[cluster]!;

  const url = RPC_URLS[cluster];
  const conn = new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });

  connections[cluster] = conn;
  return conn;
}

function getUsdcMint(): PublicKey {
  const mint = process.env.USDC_MINT_ADDRESS;
  if (!mint) throw new Error('USDC_MINT_ADDRESS not configured');
  return new PublicKey(mint);
}

function getTreasuryPublicKey(): PublicKey {
  const treasury = process.env.TREASURY_WALLET_PUBLIC_KEY;
  if (!treasury) throw new Error('TREASURY_WALLET_PUBLIC_KEY not configured');
  return new PublicKey(treasury);
}

/**
 * Returns the USDC balance on a specific cluster.
 */
export async function getUsdcBalance(publicKey: string, cluster: SolanaCluster = 'devnet'): Promise<number> {
  const connection = getConnection(cluster);
  const usdcMint = getUsdcMint();
  const owner = new PublicKey(publicKey);

  try {
    const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(owner, {
      mint: usdcMint,
    });

    if (tokenAccounts.length === 0) return 0;
    const balance = tokenAccounts[0].account.data.parsed.info.tokenAmount.uiAmount as number;
    return balance ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Transfers USDC to the treasury on a specific cluster.
 */
export async function transferUsdcToTreasury(
  wallet: UserWallet,
  usdcAmount: number,
  cluster: SolanaCluster = 'devnet',
): Promise<string> {
  const treasury = getTreasuryPublicKey();
  return transferUsdc(wallet, treasury.toBase58(), usdcAmount, cluster);
}

/**
 * Transfers SOL on a specific cluster.
 */
export async function transferSol(
  wallet: UserWallet,
  recipient: string,
  amountSol: number,
  cluster: SolanaCluster = 'devnet',
): Promise<string> {
  const connection = getConnection(cluster);
  const signingKeypair = getSigningKeypair(wallet);
  const senderPublicKey = new PublicKey(wallet.solana_public_key);
  const recipientPublicKey = new PublicKey(recipient);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const minRequired = lamports + 5000; // Transfer amount + standard tx fee
  const balance = await connection.getBalance(senderPublicKey);
  if (balance < minRequired) {
    throw new Error(`Insufficient SOL for transfer and network fees. You need at least ${amountSol + 0.000005} SOL.`);
  }

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: senderPublicKey,
      toPubkey: recipientPublicKey,
      lamports,
    }),
  );

  // ── Standard Flow ──────────────────────────────────────────
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [signingKeypair],
    { commitment: 'confirmed' as Commitment },
  );

  return signature;
}

/**
 * Transfers USDC on a specific cluster.
 */
export async function transferUsdc(
  wallet: UserWallet,
  recipient: string,
  usdcAmount: number,
  cluster: SolanaCluster = 'devnet',
): Promise<string> {
  const connection = getConnection(cluster);
  const usdcMint = getUsdcMint();
  const recipientPk = new PublicKey(recipient);

  const signingKeypair = getSigningKeypair(wallet);
  const senderPublicKey = new PublicKey(wallet.solana_public_key);
  const rawAmount = BigInt(Math.round(usdcAmount * Math.pow(10, USDC_DECIMALS)));

  // ── Gas Check ──────────────────────────────────────────
  // Check if sender has enough SOL for tx fees + potentially creating ATA (~0.002 SOL)
  const solBalance = await connection.getBalance(senderPublicKey);
  if (solBalance < 0.002 * LAMPORTS_PER_SOL) {
    throw new Error(`Insufficient SOL for network fees. You need at least 0.002 SOL for gas.`);
  }

  const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    signingKeypair,
    usdcMint,
    senderPublicKey,
  );

  const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    signingKeypair,
    usdcMint,
    recipientPk,
  );

  const senderAccount = await getAccount(connection, senderTokenAccount.address);
  if (senderAccount.amount < rawAmount) {
    throw new Error(`Insufficient USDC`);
  }

  const transaction = new Transaction().add(
    createTransferInstruction(
      senderTokenAccount.address,
      recipientTokenAccount.address,
      senderPublicKey,
      rawAmount,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );


  // ── Standard Flow ──────────────────────────────────────────
  // Requires user's wallet to have SOL for network fees.
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [signingKeypair],
    { commitment: 'confirmed' as Commitment },
  );

  return signature;
}

export async function getSolBalance(publicKey: string, cluster: SolanaCluster = 'devnet'): Promise<number> {
  const connection = getConnection(cluster);
  try {
    const lamports = await connection.getBalance(new PublicKey(publicKey));
    return lamports / 1e9;
  } catch (err: any) {
    console.error(`[solana:${cluster}] getSolBalance failed: ${err.message}`);
    throw new Error(`Failed to retrieve SOL balance on ${cluster}: ${err.message}`);
  }
}

/**
 * Wraps SOL into WSOL for the user.
 */
export async function wrapSol(
  wallet: UserWallet,
  amountSol: number,
  cluster: SolanaCluster = 'devnet'
): Promise<string> {
  const connection = getConnection(cluster);
  const signingKeypair = getSigningKeypair(wallet);
  const senderPublicKey = new PublicKey(wallet.solana_public_key);
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    signingKeypair,
    wsolMint,
    senderPublicKey
  );

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: senderPublicKey,
      toPubkey: ata.address,
      lamports,
    }),
    {
      keys: [{ pubkey: ata.address, isSigner: false, isWritable: true }],
      programId: TOKEN_PROGRAM_ID,
      data: Buffer.from([17]), // SyncNative instruction
    }
  );

  return await sendAndConfirmTransaction(connection, transaction, [signingKeypair]);
}

/**
 * Builds an explorer link for a transaction based on the cluster used.
 */
export function explorerLink(signature: string, cluster: SolanaCluster = 'devnet'): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}
