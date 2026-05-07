import {
  getUmbraClient,
  createSignerFromPrivateKeyBytes,
  getUserRegistrationFunction,
  getPublicBalanceToSelfClaimableUtxoCreatorFunction,
  getSelfClaimableUtxoToPublicBalanceClaimerFunction,
  getClaimableUtxoScannerFunction,
  getSelfClaimableUtxoToEncryptedBalanceClaimerFunction
} from '@umbra-privacy/sdk';
import {
  getUserRegistrationProver,
  getCreateSelfClaimableUtxoFromPublicBalanceProver,
  getClaimSelfClaimableUtxoIntoPublicBalanceProver
} from '@umbra-privacy/web-zk-prover';
import { PublicKey } from '@solana/web3.js';
import { UserWallet } from '../types/index.js';
import { decrypt } from '../utils/crypto.js';
import { SolanaCluster } from '../config/networks.js';
import { getSupabase } from './supabase.js';
import { wrapSol, getConnection } from './solana.js';
import bs58 from 'bs58';

/**
 * Creates an Umbra client instance.
 */
async function getUmbraClientInstance(wallet: UserWallet, cluster: SolanaCluster): Promise<any> {
  const privateKeyBase58 = decrypt(wallet.encrypted_private_key);
  const secretKey = bs58.decode(privateKeyBase58);
  const signer = await createSignerFromPrivateKeyBytes(secretKey);

  const network = cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
  const rpcUrl = cluster === 'mainnet-beta'
    ? (process.env.SOLANA_MAINNET_RPC_URL ?? 'https://api.mainnet-beta.solana.com')
    : (process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com');

  return await getUmbraClient({
    signer: signer as any,
    network: network as any,
    rpcUrl,
    rpcSubscriptionsUrl: rpcUrl.replace('https://', 'wss://'),
    indexerApiEndpoint: 'https://indexer.api.umbraprivacy.com',
  });
}

/**
 * Registers a user for Umbra Privacy (Mandatory for shielding/claiming).
 */
export async function registerUmbra(wallet: UserWallet, cluster: SolanaCluster = 'devnet'): Promise<void> {
  const client = await getUmbraClientInstance(wallet, cluster);
  const prover = getUserRegistrationProver();
  // @ts-ignore
  const registerFunc = getUserRegistrationFunction({ client }, { zkProver: prover });

  console.log(`[umbra] Registering privacy for ${wallet.telegram_id} on ${cluster}...`);
  await registerFunc({
    confidential: true,
    anonymous: true
  });

  // Update registration status in DB
  const { error } = await getSupabase()
    .from('user_wallets')
    .update({ umbra_registered: true })
    .eq('telegram_id', wallet.telegram_id);

  if (error) {
    console.error(`[umbra] Failed to update registration status in DB:`, error.message);
  } else {
    console.log(`[umbra] Successfully updated registration status for ${wallet.telegram_id}`);
  }
}

const MIN_SOL_FOR_PRIVACY = 0.005; // Requirement for ZK Proof Account rent on Solana

/**
 * Sends funds PRIVATELY to ANY Solana address (even if unregistered).
 * Uses the Mixer approach: Shield to Self -> Claim to Recipient.
 */
export async function sendPrivate(
  wallet: UserWallet,
  recipientAddress: string,
  amount: number,
  mintAddress: string,
  cluster: SolanaCluster = 'mainnet-beta'
): Promise<string> {
  const client = await getUmbraClientInstance(wallet, cluster);
  const connection = getConnection(cluster);

  // Pre-check balance for gas/rent
  const balance = await connection.getBalance(new PublicKey(wallet.solana_public_key));
  const balanceSol = balance / 1e9;

  if (balanceSol < MIN_SOL_FOR_PRIVACY) {
    throw new Error(`Insufficient SOL. You need at least ${MIN_SOL_FOR_PRIVACY} SOL to cover network rent.`);
  }

  const decimals = mintAddress === 'SOL' ? 9 : 6;
  const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));

  // Map SOL to Wrapped SOL (WSOL) Mint - Standard for Umbra SOL transfers
  const actualMint = mintAddress === 'SOL' ? 'So11111111111111111111111111111111111111112' : mintAddress;

  console.log(`[umbra] Initiating Universal Private Transfer of ${amount} ${mintAddress} to ${recipientAddress} on ${cluster}...`);

  // If native SOL, we need to wrap it first as Umbra works on WSOL
  if (mintAddress === 'SOL') {
    console.log(`[umbra] Wrapping ${amount} SOL into WSOL...`);
    await wrapSol(wallet, amount, cluster);
  }

  // STEP 1: Shield Public Balance to Mixer (Self-Claimable UTXO)
  const depositProver = getCreateSelfClaimableUtxoFromPublicBalanceProver();
  // @ts-ignore
  const depositFunc = getPublicBalanceToSelfClaimableUtxoCreatorFunction({ client }, { zkProver: depositProver });

  try {
    console.log(`[umbra:1] Shielding funds in Mixer...`);
    // @ts-ignore
    const depositResult = await depositFunc({
      amount: rawAmount as any,
      mint: actualMint as any,
      destinationAddress: wallet.solana_public_key as any
    });

    console.log(`[umbra] Deposit Result:`, JSON.stringify(depositResult));

    // Wait for indexer to catch up
    console.log(`[umbra] Waiting for Mixer to confirm deposit...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Find the UTXO we just created
    const scanner = getClaimableUtxoScannerFunction({ client });
    // @ts-ignore
    const { received } = await scanner(0n, 0n, 10n); // Scan last few blocks

    const utxos = Array.isArray(received) ? received : (received ? [received] : []);
    if (utxos.length === 0) {
      throw new Error("Deposit received but privacy credit not yet initialized. Please wait a moment.");
    }

    const utxoData = utxos[utxos.length - 1]; // Use the newest one

    // STEP 2: Claim Mixer Credit to Recipient's Public Address
    const claimProver = getClaimSelfClaimableUtxoIntoPublicBalanceProver();
    // @ts-ignore
    const claimFunc = getSelfClaimableUtxoToPublicBalanceClaimerFunction({ client }, { zkProver: claimProver });

    console.log(`[umbra:2] Routing funds from Mixer to recipient (Anonymized)...`);
    // @ts-ignore
    const claimResult = await claimFunc({
      utxoData,
      destinationAddress: recipientAddress as any
    } as any);

    const res = claimResult as any;
    return res.txId || res.signature || (Array.isArray(res) ? res[0] : res);
  } catch (err: any) {
    if (err.message?.includes('simulation failed') || err.message?.includes('ProofAccount')) {
      throw new Error(`Privacy Shield failed: Insufficient SOL for network rent. Ensure your wallet has at least 0.005 SOL.`);
    }
    if (err.message?.includes('Account not found')) {
      throw new Error(`Privacy Shield failed: Asset account missing. If sending SOL, ensure you have a small balance left for gas.`);
    }
    throw err;
  }
}

/**
 * Scans and claims incoming private funds (Background loop).
 */
export async function syncPrivateCredits(wallet: UserWallet, cluster: SolanaCluster = 'mainnet-beta'): Promise<number> {
  try {
    const client = await getUmbraClientInstance(wallet, cluster);

    const scanner = getClaimableUtxoScannerFunction({ client });
    // @ts-ignore
    const result = await scanner(0n, 0n, 1000n);
    const received = result?.received;

    if (!received) return 0;

    const utxos = Array.isArray(received) ? received : [received];
    if (utxos.length === 0) return 0;

    console.log(`[umbra] Found ${utxos.length} private ghost credits for ${wallet.telegram_id} on ${cluster}.`);

    const claimProver = getCreateSelfClaimableUtxoFromPublicBalanceProver(); // Reuse for self-claims
    // @ts-ignore
    const claimer = getSelfClaimableUtxoToEncryptedBalanceClaimerFunction({ client }, { zkProver: claimProver } as any);

    let count = 0;
    for (const utxo of utxos) {
      try {
        await claimer({ utxoData: utxo } as any);
        count++;
      } catch (err) {
        console.error(`[umbra] Failed to claim ghost UTXO:`, err);
      }
    }

    return count;
  } catch (err) {
    console.error(`[umbra] syncPrivateCredits failed:`, err);
    return 0;
  }
}