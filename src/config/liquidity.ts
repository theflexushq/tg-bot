/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LIQUIDITY CONFIGURATION
 * ─────────────────────────────────────────────────────────────────────────────
 * This file controls whether the bot uses PAJ's built-in liquidity pool 
 * (Full Ramp) or the platform's own treasury for crypto delivery.
 */

export type LiquidityMode = 'PAJ_MANAGED' | 'OWN_TREASURY';

export interface TokenLiquidity {
  USDC: LiquidityMode;
  SOL: LiquidityMode;
}

/**
 * Change these settings to switch liquidity sources.
 * 
 * PAJ_MANAGED (Default): 
 * - PAJ handles crypto delivery on onramp.
 * - PAJ handles fiat delivery on offramp.
 * - Minimum friction, no treasury needed.
 * 
 * OWN_TREASURY:
 * - Bot manually sends crypto to user from treasury on onramp.
 * - Bot handles manual fiat payouts on offramp.
 * - Useful as you scale and want to manage your own float.
 */
export const LIQUIDITY_CONFIG: TokenLiquidity = {
  USDC: 'PAJ_MANAGED', // Set to PAJ_MANAGED for now as requested
  SOL: 'PAJ_MANAGED',
};

/**
 * Returns true if the bot should handle crypto distribution itself.
 */
export function isUsingOwnLiquidity(token: 'USDC' | 'SOL'): boolean {
  return LIQUIDITY_CONFIG[token] === 'OWN_TREASURY';
}
