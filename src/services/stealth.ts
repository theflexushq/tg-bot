import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { Bot } from 'grammy';
import { getSupabase } from './supabase.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { StealthReceiver, UserWallet } from '../types/index.js';
import { getSolBalance, getUsdcBalance, getConnection } from './solana.js';
import { sendPrivate } from './umbra.js';
import { getWallet } from './wallet.js';
import { BotContext } from '../types/context.js';

const supabase = () => getSupabase();

/**
 * Generates a one-time stealth receiver for a user.
 */
export async function createStealthReceiver(telegramId: string): Promise<StealthReceiver> {
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const encryptedPrivateKey = encrypt(bs58.encode(keypair.secretKey));

  const { data, error } = await supabase()
    .from('stealth_receivers')
    .insert({
      telegram_id: telegramId,
      solana_public_key: publicKey,
      encrypted_private_key: encryptedPrivateKey,
      active: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create stealth receiver: ${error.message}`);
  return data as StealthReceiver;
}

/**
 * Fetches all active stealth receivers.
 */
export async function getActiveStealthReceivers(): Promise<StealthReceiver[]> {
  const { data, error } = await supabase()
    .from('stealth_receivers')
    .select('*')
    .eq('active', true);

  if (error) throw new Error(`Failed to fetch stealth receivers: ${error.message}`);
  return data as StealthReceiver[];
}

/**
 * Process any funds received on stealth addresses by moving them PRIVATELY to the main wallet.
 */
export async function processStealthReceivals(bot: Bot<BotContext>): Promise<number> {
  const receivers = await getActiveStealthReceivers();
  let count = 0;

  for (const receiver of receivers) {
    try {
      // Check balances on Mainnet (privacy is most important on mainnet)
      const sol = await getSolBalance(receiver.solana_public_key, 'mainnet-beta').catch(() => 0);
      const usdc = await getUsdcBalance(receiver.solana_public_key, 'mainnet-beta').catch(() => 0);

      if (sol > 0.006 || usdc > 0) { // 0.005 is roughly rent cost for ZK proof
        console.log(`[stealth] Detected funds on ${receiver.solana_public_key} for ${receiver.telegram_id}`);
        
        const mainWallet = await getWallet(receiver.telegram_id);
        if (!mainWallet) continue;

        // Create a temporary UserWallet object for the stealth receiver so we can use sendPrivate
        const tempWallet: UserWallet = {
          ...mainWallet, // use some metadata from main wallet
          solana_public_key: receiver.solana_public_key,
          encrypted_private_key: receiver.encrypted_private_key,
        };

        let txId = '';
        let amountStr = '';
        if (usdc > 0) {
          amountStr = `${usdc} USDC`;
          txId = await sendPrivate(tempWallet, mainWallet.solana_public_key, usdc, 'USDC', 'mainnet-beta');
        } else if (sol > 0.006) {
          const amountToSend = sol - 0.0055; // Leave some for gas
          amountStr = `${amountToSend.toFixed(6)} SOL`;
          txId = await sendPrivate(tempWallet, mainWallet.solana_public_key, amountToSend, 'SOL', 'mainnet-beta');
        }

        if (txId) {
          console.log(`[stealth] Successfully routed funds privately to main wallet. Tx: ${txId}`);
          
          // Mark as inactive
          await supabase()
            .from('stealth_receivers')
            .update({ active: false })
            .eq('id', receiver.id);
            
          // Notify User
          await bot.api.sendMessage(receiver.telegram_id, 
            `🤫 *Stealth Deposit Received!*\n\n` +
            `Funds sent to your temporary address have been detected and privately routed to your main wallet.\n\n` +
            `💰 *Amount:* ${amountStr}\n` +
            `🛡️ *Privacy:* Routed via Umbra Mixer (No on-chain link to sender).\n\n` +
            `_Your balance has been updated._`,
            { parse_mode: 'Markdown' }
          ).catch(() => null);

          count++;
        }
      }
    } catch (err) {
      console.error(`[stealth] Failed to process receiver ${receiver.solana_public_key}:`, err);
    }
  }

  return count;
}
