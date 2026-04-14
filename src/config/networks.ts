export type SolanaCluster = 'mainnet-beta' | 'devnet';

export interface NetworkConfig {
  TRANSFER: SolanaCluster;
  OFFRAMP: SolanaCluster;
  ONRAMP: SolanaCluster;
  UTILITY: SolanaCluster;
}

/**
 * Configure which Solana network each feature uses.
 * Useful for testing specific features on Devnet while others are on Mainnet.
 */
export const FEATURE_NETWORKS: NetworkConfig = {
  TRANSFER: 'mainnet-beta',
  OFFRAMP: 'mainnet-beta',
  ONRAMP: 'mainnet-beta',
  UTILITY: 'devnet',
};

/**
 * Returns the appropriate cluster for a given feature action.
 */
export function getClusterForAction(action: string): SolanaCluster {
  if (action === 'TRANSFER') return FEATURE_NETWORKS.TRANSFER;
  if (action === 'OFFRAMP') return FEATURE_NETWORKS.OFFRAMP;
  if (action === 'BUY_USDC') return FEATURE_NETWORKS.ONRAMP;
  if (action === 'BUY_AIRTIME' || action === 'BUY_DATA' || action === 'PAY_BILL') return FEATURE_NETWORKS.UTILITY;
  return 'devnet'; // Fallback
}
