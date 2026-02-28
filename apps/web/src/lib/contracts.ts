/**
 * contracts.ts — addresses and ABIs for deployed DustSweep contracts
 *
 * After running: forge script script/Deploy.s.sol --broadcast
 * Copy the printed addresses into your .env.local file, e.g.:
 *   NEXT_PUBLIC_ROUTER_ADDRESS=0x...
 *   NEXT_PUBLIC_BURN_VAULT_ADDRESS=0x...
 *   NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS=0x...
 */

// ─── Addresses (loaded from env) ─────────────────────────────────────────────
export const CONTRACT_ADDRESSES = {
  84532: {                                              // Base Sepolia (testnet)
    dustSweepRouter: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS       ?? '0x0') as `0x${string}`,
    burnVault:       (process.env.NEXT_PUBLIC_BURN_VAULT_ADDRESS    ?? '0x0') as `0x${string}`,
    feeCollector:    (process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS ?? '0x0') as `0x${string}`,
  },
  8453: {                                               // Base Mainnet
    dustSweepRouter: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS       ?? '0x0') as `0x${string}`,
    burnVault:       (process.env.NEXT_PUBLIC_BURN_VAULT_ADDRESS    ?? '0x0') as `0x${string}`,
    feeCollector:    (process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS ?? '0x0') as `0x${string}`,
  },
} as const;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

export const DUST_SWEEP_ROUTER_ABI = [
  {
    name: 'sweepDust',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'inputTokens',    type: 'address[]' },
          { name: 'inputAmounts',   type: 'uint256[]' },
          { name: 'outputToken',    type: 'address'   },
          { name: 'minOutputAmount', type: 'uint256'  },
          { name: 'swapCalldata',   type: 'bytes[]'   },
        ],
      },
    ],
    outputs: [{ name: 'userReceived', type: 'uint256' }],
  },
  {
    name: 'sweepFeeBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const BURN_VAULT_ABI = [
  {
    name: 'burnTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokens',  type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [{ name: 'burnId', type: 'bytes32' }],
  },
  {
    name: 'reclaimTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'burnId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'getUserBurns',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
  },
] as const;

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address'  },
      { name: 'amount',  type: 'uint256'  },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
