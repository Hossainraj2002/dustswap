# DustSweep Permit2 Router V2 Remix Deployment

## Contract

- File: `packages/contracts/src/DustSweepPermit2RouterV2.sol`
- Compiler: Solidity `0.8.20`
- Optimizer: enabled, `200` runs
- EVM version: `paris`
- Imports:
  - `@openzeppelin/contracts/access/Ownable.sol`
  - `@openzeppelin/contracts/token/ERC20/IERC20.sol`
  - `@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol`
  - `@openzeppelin/contracts/utils/ReentrancyGuard.sol`

## Constructor Arguments

`DustSweepPermit2RouterV2(address _permit2, address _owner, address _feeCollector, uint16 _feeBps)`

Base mainnet defaults:

- `_permit2`: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- `_owner`: owner/admin wallet
- `_feeCollector`: protocol fee collector wallet or contract
- `_feeBps`: `60` for 0.60 percent, max `300`

If `_feeBps` is greater than zero, `_feeCollector` cannot be zero.

## Deploy In Remix

1. Open Remix and create `DustSweepPermit2RouterV2.sol`.
2. Paste the exact file contents from `packages/contracts/src/DustSweepPermit2RouterV2.sol`.
3. Use compiler `0.8.20`.
4. Enable optimizer with `200` runs.
5. Deploy on Base mainnet with the constructor args above.
6. Save the deployed address as `DUST_SWEEP_ROUTER_V2_ADDRESS`.

## Owner Setup Calls

Call these from the owner wallet after deployment:

```solidity
setFeeBps(60)
setFeeCollector(0xYourFeeCollector)

setAllowedTarget(0x2626664c2603336E57B271c5C0b26F421741e481, true) // Uniswap V3 SwapRouter02
setAllowedSpender(0x2626664c2603336E57B271c5C0b26F421741e481, true)

setAllowedTarget(0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7, true) // Uniswap Universal Router 2.1.1, used for V4
setAllowedSpender(0x000000000022D473030F116dDEE9F6B43aC78BA3, true) // Permit2 allowance-transfer spender for Universal Router V4

setAllowedTarget(0x1b81D678ffb9C0263b24A97847620C99d213eB14, true) // PancakeSwap V3 Swap Router
setAllowedSpender(0x1b81D678ffb9C0263b24A97847620C99d213eB14, true)

setAllowedTarget(0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43, true) // Aerodrome Router
setAllowedSpender(0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43, true)

setAllowedTarget(0x327Df1E6de05895d2ab08513aaDD9313Fe505d86, true) // BaseSwap Router
setAllowedSpender(0x327Df1E6de05895d2ab08513aaDD9313Fe505d86, true)
```

Only add aggregator targets/spenders after the backend is configured to build exact final calldata for that provider.

## Env Updates

Backend:

```env
DUST_SWEEP_EXECUTION_LANE=owned_v2
DUST_SWEEP_ROUTER_V1_ADDRESS=0xYourLegacyV1
DUST_SWEEP_ROUTER_V2_ADDRESS=0xYourNewV2
DUST_SWEEP_FEE_BPS=60
DUST_SWEEP_FEE_COLLECTOR=0xYourFeeCollector
PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
DUST_SWEEP_ALLOWED_TARGETS=0x2626664c2603336E57B271c5C0b26F421741e481,0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7,0x1b81D678ffb9C0263b24A97847620C99d213eB14,0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43,0x327Df1E6de05895d2ab08513aaDD9313Fe505d86
DUST_SWEEP_ALLOWED_SPENDERS=0x2626664c2603336E57B271c5C0b26F421741e481,0x000000000022D473030F116dDEE9F6B43aC78BA3,0x1b81D678ffb9C0263b24A97847620C99d213eB14,0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43,0x327Df1E6de05895d2ab08513aaDD9313Fe505d86
UNISWAP_UNIVERSAL_ROUTER_ADDRESS=0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7
UNISWAP_V4_QUOTER_ADDRESS=0x0d5e0F971ED27FBfF6c2837bf31316121532048D
```

Frontend:

```env
NEXT_PUBLIC_DUST_SWEEP_EXECUTION_LANE=owned_v2
NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS=0xYourNewV2
NEXT_PUBLIC_DUST_SWEEP_FEE_BPS=60
NEXT_PUBLIC_PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
```

## Base Mainnet Notes

- Permit2 requires each ERC-20 to approve the Permit2 contract before the V2 sweep signature can transfer it.
- Uniswap V4 execution goes through Universal Router. For that path the router temporarily approves Permit2 and sets a bounded Permit2 allowance for Universal Router, then clears both allowances after the route call.
- Native ETH is not a Permit2 token. The app should show ETH as wrap-required and later can batch wrap-to-WETH only for wallets that support EIP-5792.
- Protocol fees are taken from gross final output after the gross slippage check, then paid immediately to `feeCollector`.
- Rescue functions are for accidental stuck tokens/native ETH only; normal fees should not remain in the router.
