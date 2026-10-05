# memefun contracts

On-chain system for [memefun.dustswap.wtf](https://memefun.dustswap.wtf), a meme-coin launchpad on Base. Every coin is a native **B20** token with no admin and a fixed supply of 1,000,000,000. A launch locks that supply forever across one to five **Uniswap v4** positions, one per selected pair asset. A v4 hook takes a fee on every trade in the pair asset (ETH, USDC or a listed tokenized stock), and the coin's chosen destination receives it.

This package is separate from `packages/contracts` on purpose. Uniswap v4 needs solc 0.8.26 and the cancun EVM, while the live DustSwap routers there must stay on paris.

## What nobody can do

This includes the memefun owner:

- Mint, pause, seize or rename a coin. The B20 is created with `initialAdmin = address(0)` and no role is ever granted, so its privileged surface is closed forever.
- Remove or move a coin's launch liquidity, add foreign liquidity to its pool, or donate to it. The hook rejects all of these from every caller.
- Raise a coin's fee, or change its fee destination, splits or launch protection. These terms are snapshotted at launch, and only the creator can lower the fee.
- Stop trading. There is no pause on existing coins.
- Withdraw creator or referral fees without the corresponding claim right. X-author reserves follow the shared treasury rule below.

## What the owner (a Safe) can do

- Change launch settings for **new** coins: creation fee, fee range, platform and referral shares, creator-keep limit, launch protection, and opening market cap. Every one is bounded by a compile-time cap.
- Pause **new** launches.
- List and price pair assets, switch pair kinds and fee destinations on or off for new launches, and point a destination at a new module for new launches.
- Set the treasury, price keeper, rewards publisher and tweet attestor. These roles also affect existing rewards and author verification.
- Veto a holder-reward epoch within 12 hours of publication.

## Bounded trust

| Role | Can | Bounded by |
|---|---|---|
| Price keeper | Update a tokenized stock's USD price, which is used only to place new coins' opening price | +/-20% per update, staleness limit, and the creator's tick-drift guard at launch |
| Rewards publisher | Publish holder-reward Merkle roots | Each coin's reserved total (claims can never exceed it), the 12-hour owner veto, and public recomputability from Transfer events |
| Keeper | Trigger buybacks and floor adds | Permissionless with cooldowns and same-block spot guards; buybacks have an impact cap. These do not prevent price manipulation across blocks. |
| Tweet attestor | Attest original post identity and bind an unverified author wallet | EIP-712 chain/contract domain, identity, caller wallet, expiry and one-time binding. A compromised attestor can still misbind an unverified author. |
| Treasury | Claim platform fees, and unpaid author rewards after launch +180 days | Author reserves are protected for the first 180 days. Afterwards author and treasury claim the same unpaid pot; each withdrawal reduces the other party's available balance. |

## Contracts

| Contract | Role |
|---|---|
| `MemeFunConfig` | Every owner setting, with hard caps. The only contract the admin page writes. Setter names match `apps/memefun/src/lib/admin/ownerCalls.ts`. |
| `MemeFunFactory` | Launches a coin in one transaction: creates the admin-less B20, prices each market, registers frozen fee terms, initializes one to five pools, locks their supply allocations, and runs optional first buys. |
| `MemeFunHook` | The v4 hook and coin/market registry. Locks liquidity, takes the fee in each pair asset for all four swap types, applies launch protection, and honors referrals only from `MemeFunRouter`. |
| `FeeVault` | Holds every fee as ERC-6909 claims and pays creators, referrers and the treasury when they claim (pull, never push). |
| `MemeFunRouter` | The app's exact-input buy and sell, with minimum output, deadline, referrer, and ERC-2612 permit variants. It never holds funds. |
| `BuybackBurnVault` | Burn mode. A permissionless buyback with a cooldown, a same-block pump guard and an impact cap. Every coin bought goes to `0x...dEaD`. |
| `FloorVault` | Floor mode. Turns fees into permanent, quote-only bid liquidity 50-90% under the price; the floor ratchets up. |
| `HolderRewardDistributor` | Holders mode. One Merkle root per epoch, a 12-hour veto, per-market payout caps, and 90-day expiry back to the relevant pair's pot. Legacy primary-market epochs retain their original leaf format. |

**Libraries.**
- `FeeMath` and `LaunchMath` are integer-exact mirrors of `apps/memefun/src/core`; golden vectors prove parity (see Tests).
- `HookDataLib` encodes and decodes the router's hookData.

## Fee mechanics

### Creator controls after launch

The creator can lower the trading fee, including to zero. A reduction applies to every market of the coin; it cannot raise any market's rate. Creator, Burn, Holders and Floor modes, their splits, and launch protection remain fixed.

Changing a payout address and transferring the creator role are different operations:

- A creator fee claim may pay a chosen wallet without transferring control.
- `proposeCreator` nominates a new creator wallet; that wallet must call `acceptCreator`. The current creator may cancel a pending proposal. An accepted transfer moves fee-lowering authority and all unclaimed creator earnings, across every pair asset, to the new creator.
- The platform owner may change the protocol treasury wallet, but cannot take over a coin's creator role. Global fee defaults and split changes apply only to future launches.

### Multiple pairs

`launch` preserves the single-pair entry point. `launchMulti` creates the same token across one to five distinct pair assets that the quote registry permits. The token supply is split equally, with integer rounding accounted for. The opening token price uses the full fixed supply and the configured opening FDV; selecting five pairs does not multiply the opening market cap by five. Each market receives its own supply allocation, permanently locked position, and optional first buy. The entire transaction reverts if any market fails validation, pricing, funding or slippage checks.

The first selected pair remains the primary market for legacy read and action wrappers. Explicit market functions select a registered pair; an arbitrary quote cannot redirect trading or fees. Creator and module balances are kept per coin and pair asset, so ETH, 6-decimal stablecoin units and stock units are never added together. Fee policy and creator control are shared by all markets.

These changes require a deployment of the updated contracts and matching indexer/app ABIs. Existing single-pair tokens cannot acquire another launch pool by withdrawing their permanently locked supply.

The fee is the rate *r* times the trade's gross quote amount, rounded **up**, and always taken in the pair asset:

| Swap | Taken in | Fee |
|---|---|---|
| Buy, exact in (quote X in) | `beforeSwap`, specified delta | `ceil(X*r)` |
| Sell, exact out (quote N out) | `beforeSwap`, specified delta | `ceil(N*r/(1-r))` |
| Sell, exact in (pool pays Y) | `afterSwap`, unspecified delta | `ceil(Y*r)` |
| Buy, exact out (pool takes Y) | `afterSwap`, unspecified delta | `ceil(Y*r/(1-r))` |

**Launch protection.** The rate starts at the protection rate (default 50%) and decays linearly to the coin's own fee over the protection window (default 15 s). The creator's first buy inside the launch transaction pays the coin's own fee.

**Splits.** The platform share comes first; the referral share is carved from it, and only for trades through `MemeFunRouter` with a referrer who is not the trader. The rest goes to the creator (creator mode), or to the destination minus the creator's keep (community modes). Shares round down and the destination takes the remainder, so the split always equals the fee to the wei.

## Toolchain

| Dependency | Pin |
|---|---|
| solc | 0.8.26, `evm_version = cancun`, via-IR, 1,000 optimizer runs |
| forge-std | v1.15.0 |
| OpenZeppelin contracts | v5.6.1 |
| v4-core | `d153b04`: the v4.0.0 PoolManager logic deployed on Base, plus the later move of `SwapParams`/`ModifyLiquidityParams` into `types/PoolOperation.sol` (ABI-identical). It is the commit OZ uniswap-hooks v1.1.1 was audited against. |
| v4-periphery | `7ebd04b` |
| OpenZeppelin uniswap-hooks | v1.1.1 (`BaseHook`) |
| base-std | v1.1.0 (B20 interfaces and the Solidity reference mocks) |

The test-only PoolManager compiles under v4-core's own profile (`additional_compiler_profiles` in `foundry.toml`). Tests deploy it from that artifact.

## Tests

```bash
forge test                                   # stock forge: base-std's Solidity B20 mocks
FOUNDRY_BASE=true ~/.base-foundry/bin/forge test           # Base's real Rust B20 precompiles
MEMEFUN_FORK_TESTS=1 FOUNDRY_BASE=true ~/.base-foundry/bin/forge test --match-path "test/fork/*"
forge coverage --ir-minimum --no-match-path "test/fork/*"
cd ../../apps/memefun && pnpm vectors        # regenerate golden vectors from the app's TS math
```

`base-forge` is Base's Foundry build (github.com/base/base-anvil releases). It is installed separately from stock forge, at `~/.base-foundry/bin`.

| Suite | What it proves |
|---|---|
| `test/unit/SwapVectors.t.sol` | 120 pools and 544 swaps from the app's swap engine (`src/core/uniswap/swap.ts`) replayed on a real PoolManager: launch positions, floor bands, partial fills to the price limit, and swaps across tick-bitmap word edges. Input used, output, price and tick match to the unit, so the app's trade quotes and minimum outputs are exact. |
| `test/unit/TestnetFaucet.t.sol` | The testnet stock faucet holds `MINT_ROLE` from the stock's creation and gives each address 10 shares once a day. |
| `test/unit/Vectors.t.sol` | 720 golden vectors from the app's TypeScript (fees, splits, protection schedule, launch positions across 6/8/18 decimals and both orderings, including the reduced-precision branch) match the contracts to the wei. |
| `test/fuzz/*` | Fee rounding is minimal and never short. Splits conserve every wei. Protection never rises. Every opening is at or at most one spacing above target. The supply always fits the pool. A 1,000-run end-to-end fee-engine fuzz covers every swap type, both orderings, any fee, and inside or after protection. |
| `test/unit/Launch.t.sol` | Admin-less coins with no role anywhere, the exact opening price, supply locked with dust to dEaD, first buys at the base fee, snapshotted terms, and every validation. |
| `test/unit/MultiLaunch.t.sol` | Two, three and five markets conserve supply and share opening FDV; exact deposits, atomic failures, finite-range refunds, creator transfers and lower fees, per-market module pots, and separate legacy/pool reward formats. |
| `test/unit/Fees.t.sol` | All four swap types on both orderings, launch protection, referrals (router only, self-referral dropped), the builder-code calldata suffix, fee lowering to 0, and the `Trade` event (trader side, plus the exact post-swap price and tick on both orderings). |
| `test/unit/VaultAndLocks.t.sol` | Claims pay only their owner, a reentrant or ETH-rejecting recipient cannot hurt anyone, and liquidity cannot be removed, added, donated or re-initialized. |
| `test/unit/Modules.t.sol` | Buyback (no fee, cooldown, same-block pump guard, impact cap), floor (quote-only bands, same-block reference, ratchet), holder rewards (veto window, epoch caps, expiry, replay). A prior-block moved price is accepted. |
| `test/unit/AdminAndEdges.t.sol` | The owner's whole surface and its caps, keeper bounds, oracle guards, permits, and edge reverts. |
| `test/attack/Attacks.t.sol` | 99% protection on exact-out, dust swaps, direct callback calls, stray ETH, and spoofed exemptions. |
| `test/attack/MultiPairIsolation.t.sol` | Unknown-pair routing, late first-buy failure rolling back every market, wrong-module calls, and atomic rollback of mixed-currency reward batches. |
| `test/invariant/*` | Seven property assertions plus one call-summary function, over 256 runs x 64 calls. `fail_on_revert=false`. The handler currently launches single-pair, non-tweet coins: fixed supply/no roles, unchanged launch liquidity, frozen terms except falling fee, vault/module solvency, no stray funds and settings caps. Multi-pair and author-pot stateful invariants remain to be added. |
| `test/fork/MainnetFork.t.sol` | On a Base mainnet fork with real precompiles: the real PoolManager, Chainlink, USDC and Coinbase's **AAPLc**, and trades through **Uniswap's own Universal Router** paying the same fee. |

**Multi-market verification (2026-10-04):** 156 stock-Forge tests pass, including eight invariants at 256 runs x 64 calls and ten fuzz cases at 1,000 runs each. All production runtime and initcode sizes fit deployment limits. The backend's 11-test integration suite also passes against fresh local Base Rust B20 precompiles, including a three-market launch, exact router quotes, creator controls and reward claims. The five mainnet fork entries used their offline guards in this run.

**Previous single-market snapshot (2026-10-03; fork, coverage and gas figures below were measured before this update):**
- **Stock forge:** 139 tests pass.
- **Live B20 precompiles:** the same tests pass (136 on 2026-10-02, plus the faucet suite since).
- **Mainnet fork:** 5 of 5 pass.
- **Coverage of `src/`:** 98.5% lines, 98.2% statements, 100% functions, 92.6% branches. Most of the remaining branches are unreachable by construction: partial-fill refunds without a price limit, `CoinSetupFailed`, `AlreadySeeded`, a zero fee at a nonzero rate (ceiling rounding makes it at least 1 wei), and malformed hookData from our own router. A few others are assembly lines the coverage tool cannot attribute.

### Gas

Successful calls on the reference mocks; Base's precompiles differ slightly. Every swap includes about 2.6k for the post-swap `slot0` read that the `Trade` event carries.

| Action | Gas |
|---|---|
| Launch (no first buy / with first buy) | ~593k / ~836k |
| Buy via router (ETH) | ~278k |
| Sell via router (ETH) | ~157k |
| Sell with permit | ~195k |
| Creator claim | ~68k |
| Buyback | ~222k |
| Floor add | ~283k |

### Contract sizes

The 2026-10-05 audit-fix build measured `MemeFunFactory` at 20,828 runtime bytes, leaving 3,748 bytes under the 24,576-byte limit. Recheck the exact release artifacts after changes. Oversized Base Solidity mocks are test-only and are not deployed by `Deploy.s.sol`.

## Static analysis

Aderyn 0.6.8, 88 detectors over 1,792 nSLOC.

**High findings (all reviewed):**
- **H-1, state change after an external call.** False positive in every instance:
  - the calls are views on our own immutable hook or config;
  - claims, launches, buybacks, floors and publishing are all `nonReentrant`;
  - B20 tokens and ERC-6909 claims have no transfer callbacks.

  As defense in depth, the buyback and floor bookkeeping (cooldown stamp, pot zeroed) now happens before the PoolManager call.
- **H-2, unsafe integer casting.** False positive. Every cast follows a cap check: creation fee <= 0.05 ETH into `uint96`, basis points <= 9,900 into `uint16`, protection <= 300 s, creator keep <= 5,000.

**Low findings:**
- **L-9 / L-11, unchecked ERC-6909 transfer.** The return value is now checked.
- **L-7, `credit` emits no event.** Deliberate: the hook's `Trade` event carries the fee and referrer, and the split is deterministic from the snapshotted terms.
- **L-8.** Deliberate: `address(0)` disables the price keeper or the rewards publisher.
- **The rest are style.**

**Slither 0.11.6** (66 results) was run on the same sources with solc 0.8.26 via-IR, in WSL:
- **3 High, all false positives:**
  - Two "arbitrary `from` in `transferFrom`" flags in `MemeFunRouter.unlockCallback` and `MemeFunFactory.unlockCallback`. The `from` is always the original `msg.sender`, encoded by the contract itself into its own unlock data. Only the PoolManager can invoke the callback, and only for the contract that called `unlock` (`test_unlockCallbacksOnlyFromThePoolManager`).
  - "Arbitrary ETH send" in `MemeFunFactory._sendEth`. It only ever pays the owner-set treasury or refunds `msg.sender`.
- **Medium:**
  - **reentrancy-no-eth:** a false positive. Slither does not model OpenZeppelin's transient reentrancy guard. `publishEpoch` now carries the guard too.
  - **divide-before-multiply:** deliberate tick snapping.
  - **incorrect-equality:** block-number and fee comparisons, not balances.
  - **uninitialized-local:** now explicit.
  - **unused-return (17):** deliberate. These are partial tuple reads, plus `settle`/`unlock`/`initialize` results; the PoolManager reverts any unlock left unsettled.
- **Low and informational:** loops over caller-supplied arrays, `block.timestamp` comparisons for cooldowns and windows (by design), and constructor addresses without zero checks (deployment-time, asserted by the deploy script).

## Deployment

`script/Deploy.s.sol` handles deployment.

**How it works:**
- Every contract except the hook uses plain CREATE, so its address is predicted from the deployer's nonce.
- The hook uses the deterministic CREATE2 deployer, with a salt mined for its 14 permission bits.

Every cross-reference is therefore an immutable; there is no initializer to front-run, and the script asserts each predicted address. It then:
- lists ETH (Chainlink) and USDC (fixed $1);
- leaves stock pairs off until legal review;
- enables the three modules;
- sets the keeper and publisher roles if given;
- starts the two-step ownership handoff to `OWNER`, which must call `acceptOwnership()`.

**Environment variables:** `OWNER`, `TREASURY`, `PRICE_KEEPER`, `REWARDS_PUBLISHER`, `TWEET_ATTESTOR`, `DEPLOYER`, RPC URLs and optionally `ETHERSCAN_API_KEY` for Etherscan V2. See `.env.example`. Keys only ever come from an encrypted keystore (`--account`); none belong in this repo. Supply a rewards publisher or disable Holder mode before allowing public launches.

Simulations print the candidate record without saving it. `DRY_RUN=true` combined with `--broadcast` is refused. A broadcast record still needs receipt, runtime-code, immutable-reference and actual first-block checks before export. The serialized owner is the intended owner; inspect `owner()`/`pendingOwner()` and complete the handoff.

```bash
# Dry run on a simulated Base Sepolia fork, with a smoke launch, nothing broadcast:
DRY_RUN=true FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/Deploy.s.sol --fork-url https://sepolia.base.org
```

**Dry run, verified 2026-10-02** on a Base Sepolia fork with the real PoolManager and B20 precompiles:
- All 8 contracts deployed at their predicted addresses.
- The hook salt was mined in about 21k tries.
- The smoke launch created a real B20 coin, and its 0.01 ETH first buy received about 5.38M coins.
- Total cost was about 21.9M gas, roughly 0.00024 ETH at Sepolia prices.

A real broadcast writes `deployments/<chainId>.json`, which the indexer reads. It records every contract address, the ETH/USD feed, USDC, the owner, treasury, keeper and publisher, and the start block. Deployments are append-only: new versions are new deployments, and old coins keep working.

### Local chain (backend development)

`script/DevDeploy.s.sol` builds a complete memefun on a fresh `base-anvil` (chain 31337, with Base's B20 precompiles). It reuses `Deploy.s.sol`'s own deploy and configure steps, and also deploys what Base provides on real chains:
- a v4 PoolManager from v4-core's artifact;
- a mock USDC;
- an ETH/USD feed that always reports the current block time, so fast-forwarded chains never go stale;
- an 8-decimal B20 standing in for a Coinbase tokenized stock, with the stock pair enabled.

It funds anvil's dev accounts 1 to 6 with USDC and stock, makes account 8 the price keeper and account 9 the rewards publisher, and writes `deployments/31337.json` (gitignored; rewritten on every run). It uses only anvil's public test mnemonic and refuses any other chain.

```bash
~/.base-foundry/bin/anvil --base --base-activation-admin 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/DevDeploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --slow --offline
```

Pass `--offline`: otherwise forge looks up trace signatures on Sourcify after the run, and that lookup can hang indefinitely. Trading activity is seeded by the backend's seed script, which can move chain time between trades.

**Verified 2026-10-02:** about 33 transactions; all contracts at their predicted addresses; then a launch with a 0.01 ETH first buy (856k gas) and a router buy (170k gas) on the live B20 precompiles.

### Base Sepolia (testnet)

The testnet runs the same `Deploy.s.sol`, owned by the deployer's EOA, plus `script/TestnetExtras.s.sol` (testnet only; it refuses Base mainnet). Base Sepolia has no tokenized stocks, so TestnetExtras:
- creates a **test stock** (`tAAPL`, "Test stock AAPL (testnet, no value)"), a B20 with 8 decimals like Coinbase's;
- deploys `script/testnet/TestStockFaucet.sol`, which holds the stock's `MINT_ROLE` from the moment the stock exists and gives each address 10 test shares a day;
- lists the stock as a MANUAL quote at $240 (the keeper's `dev` price source keeps it fresh), enables stock pairs on the testnet only, and sets the price keeper and rewards publisher;
- adds the stock and faucet to `deployments/84532.json`.

```bash
cast wallet import memefun-testnet --interactive      # once; the key never leaves the keystore
export DEPLOYER=$(cast wallet address --account memefun-testnet)
OWNER=$DEPLOYER TREASURY=$DEPLOYER FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org --account memefun-testnet --sender $DEPLOYER \
  --broadcast --slow --verify --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/ --offline
PRICE_KEEPER=0x... REWARDS_PUBLISHER=0x... FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/TestnetExtras.s.sol \
  --rpc-url https://sepolia.base.org --account memefun-testnet --sender $DEPLOYER --broadcast --slow --offline
```

**Rehearsed 2026-10-03** on a Base Sepolia fork (base-anvil `--fork-url`): both scripts broadcast; the stock was listed at $240; the faucet minted 10 tAAPL; launches on the stock pair (floor mode) and on ETH both succeeded.

## Known limitations (accepted, documented)

- **Partial fills under a caller-set price limit.** An exact-input buy that partly fills still pays the fee on its whole input. `MemeFunRouter` never sets a price limit.
- **Uniswap's protocol fee.** A future v4 protocol fee, if governance enables one, would apply on top. Quote with `slot0.protocolFee`.
- **Tokenized stocks are issuer-controlled.** Coinbase can pause, blocklist or seize them. Pairing a coin with a stock does not confer ownership of the company. The app geofences stock pairs.
- **Holder rewards trust the publisher**, within the bounds above.
- **Referrals can be self-farmed** through a second wallet. The amount is bounded by the referral share of the platform share.
