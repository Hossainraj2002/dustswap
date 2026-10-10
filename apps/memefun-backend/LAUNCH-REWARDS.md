# Platform-token launch rewards

This campaign is separate from trading fees, X-author rewards and holder-mode rewards. It is off by default. The frontend reads the API configuration; it needs no campaign key or new public environment variables.

## Campaign rules

- Exactly 1,000 allocations, each for the same raw token amount.
- One allocation and one successful claim per wallet. This does not prove one person per wallet.
- Only launches in blocks **after** the distributor's activation block count. Earlier launches and launches in the activation block do not count.
- The first qualifying launch from each wallet reserves its position, ordered by block number and log index. Claim speed, additional launches, pair count, creator-role transfers and discovery moderation do not change that position.
- A claim pays the original launching wallet. Connect that wallet and sign in with SIWE before requesting a claim ticket. Contract-wallet sign-in uses the existing wallet authentication flow.
- Launch-only qualification starts the campaign. The owner can enable a later trade requirement once; it starts in the next block and preserves earlier participants' launch-only rules. A later positive regular trade in any MemeFun token qualifies. A creation-time first buy or a protocol/module operation does not.
- Finalized chain history and a complete index are required before tickets are issued. A new launch can show as confirming for a while. API outages prevent new tickets; they do not consume an allocation.
- Claims have no campaign expiry. A short-lived ticket can be refreshed. The contract has no reserved-token withdrawal, signer change, reward change, pause or upgrade.

The public banner and claim card disclose the wallet limit. The inactive trade requirement does not appear in the normal campaign UI. Once enabled, its rule appears for new participants; earlier wallets retain their original rule.

## Before launch

1. Launch your platform token and make the desired first purchase. The $500 or $1,000 purchase budget does **not** determine the reward amount: use the number of tokens actually received and the quantity you choose to distribute.
2. Confirm the token address, chain, decimals and total allocation. The token must transfer exact amounts; transfer-tax and rebasing tokens are unsupported. A MemeFun token has a fixed supply and ordinary transfers.
3. Set `rewardAmountRaw = floor(totalTokensRaw / 1000)`. The required reserve is `rewardAmountRaw * 1000`. Keep any division remainder in your wallet. For example, a 1,000,000-token allocation with 18 decimals pays 1,000 tokens per wallet: `rewardAmountRaw = 1000000000000000000000` and required funding is `1000000000000000000000000` raw units.
4. Create a **dedicated campaign signing key** and retain a secure backup. Put its public address in the constructor. It needs no ETH: it signs EIP-712 tickets on the server. Keep the private key only in the API service's secret environment; do not commit it or put it in `NEXT_PUBLIC_*`, Cloudflare browser assets, frontend variables or keeper variables.
5. Choose the owner wallet and confirm the current MemeFun factory from the deployment manifest. Token address, factory, signer, reward amount and cap are immutable after deployment. Changing token/name labels in the API does not rename the on-chain token or change the payout.

The signer is trusted to attest launch history, chronological slots and qualifying trades. A compromised signer can misassign the fixed reserve; it cannot increase the 1,000-claim cap or make duplicate-wallet payouts. Losing this immutable signing key prevents new tickets. Back up the key before funding, and keep the indexed launch history reproducible. This contract does not provide a signer recovery switch.

## Deployment and funding sequence

The checked-in `packages/memefun-contracts/script/DeployLaunchRewardsDryRun.s.sol` is **simulation only** and rejects broadcasting. It neither transfers tokens nor activates a campaign. Set these public variables for its constructor preflight:

```dotenv
MEMEFUN_LAUNCH_REWARD_OWNER=<owner address>
MEMEFUN_LAUNCH_REWARD_TOKEN=<platform token address>
MEMEFUN_LAUNCH_REWARD_TOKEN_DECIMALS=<actual token decimals>
MEMEFUN_LAUNCH_REWARD_AMOUNT_RAW=<equal reward per wallet in raw units>
MEMEFUN_LAUNCH_REWARD_SIGNER=<dedicated signing key's public address>
MEMEFUN_LAUNCH_REWARD_FACTORY=<current MemeFun factory address>
```

From `packages/memefun-contracts`, run a constructor simulation against the appropriate Base RPC:

```sh
forge script script/DeployLaunchRewardsDryRun.s.sol --fork-url "$BASE_MAINNET_RPC_URL" --offline
```

Never use the address created in that simulation as an actual distributor address. Deployment must use the same reviewed compiler settings (solc 0.8.26, Cancun, via-IR, optimizer 1,000), preserve DustSwap's ERC-8021 builder attribution on the creation and every funding/owner call, and wait for successful receipts. The existing attributed transaction boundary can submit funding transfers and owner calls; no approval is needed for a plain token transfer to the distributor.

`DeployLaunchRewards.s.sol` provides an attributed deployment helper. In addition to the public constructor variables, set `MEMEFUN_LAUNCH_REWARD_DEPLOYER` to the deployer's public address. Preview it first:

```sh
forge script script/DeployLaunchRewards.s.sol --rpc-url "$BASE_MAINNET_RPC_URL" --offline
```

For a reviewed live deployment, set `MEMEFUN_LAUNCH_REWARD_DEPLOY_CONFIRMED=true` and add `--broadcast --account <local-keystore-name>` to a **fresh** invocation. The CLI keystore must match the public deployer. Do not pass a private key as a command argument. **Do not use `--resume`**: Foundry can resend cached transactions without rerunning the script's confirmation checks. The helper never funds, activates, writes a deployment manifest or modifies the existing launchpad contracts.

Before any live action, confirm the constructor tuple and the token balance to allocate. Then:

1. Deploy `MemeFunLaunchRewards(owner, token, decimals, rewardAmountRaw, campaignSigner, launchFactory)` and verify its source and constructor arguments on the explorer.
2. Read the deployed getters and compare every immutable field with the reviewed plan. Keep `MEMEFUN_LAUNCH_REWARD_ENABLED=false` until the matching API release and migration are running.
3. Transfer **exactly** the required reserve to the actual distributor. Check its `balanceOf` and `totalAllocation()`. There is no withdrawal function for excess tokens, so do not overfund.
4. Configure the API variables below and release the web/API builds. Set `ENABLED=true` only when ready to start; the UI remains hidden while the distributor is unactivated or insufficiently funded.
5. The owner calls `activate()`. Its receipt establishes the permanent start block. Announce the campaign after that receipt. New eligibility starts in later blocks. Disabling and re-enabling an environment flag does not restart the campaign or shift this block.
6. After finalized indexing, check `/v1/launch-campaign`, a new launcher's wallet status, a SIWE claim ticket, and a real claim receipt/token balance. Check duplicate-wallet rejection and discovery retention before announcing broad availability.

On 10 October 2026, the Base distributor was deployed at [0xe9132055290d748940806EBd6859f5f5ab17331D](https://basescan.org/address/0xe9132055290d748940806EBd6859f5f5ab17331D) in [transaction 0x4ab764f8c3e6beff08845afdd6e8b43155b7ab56cf517468d0f83ad67e8fa0bb](https://basescan.org/tx/0x4ab764f8c3e6beff08845afdd6e8b43155b7ab56cf517468d0f83ad67e8fa0bb), block 52,416,864. Its immutable reward token is [MEMEFUN, 0xb20000000000000000000048301bd98a061ceACF](https://basescan.org/token/0xb20000000000000000000048301bd98a061ceACF), with 18 decimals. Each of the 1,000 wallets receives 100,000 MEMEFUN (`100000000000000000000000` raw units), requiring a reserve of exactly 100,000,000 MEMEFUN (`100000000000000000000000000` raw units). The [public deployment record](../../packages/memefun-contracts/deployments/launch-rewards-8453.json) contains the constructor, signer, factory, compiler settings and code hashes.

The deployed runtime has an [exact Sourcify source match](https://repo.sourcify.dev/8453/0xe9132055290d748940806EBd6859f5f5ab17331D); the successful creation input was independently matched to the compiler artifact, constructor arguments and attribution suffix. Sourcify did not record a creation match.

The distributor was unfunded and unactivated at deployment. Deployment alone does not enable rewards. Verify its source and immutable getters, transfer the required MEMEFUN reserve to that distributor address on Base, confirm its token balance, configure the API, then have the owner call `activate()` as described above. Leave `tradeRequiredFromBlock()` at zero and `MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE=false` for launch-only qualification. Eligibility starts after the activation block; it does not start at token creation or distributor deployment. Check current on-chain funding and activation state before announcing the campaign.

## Railway API variables

Configure these on **memefun-api**, not the web service. Restart/redeploy the API after changes. The app and keeper keep their existing environments. The API applies `0007_launch_campaign_quota.sql` through the existing advisory-locked migration runner on startup.

| Variable | Purpose |
| --- | --- |
| `MEMEFUN_LAUNCH_REWARD_ENABLED` | `false` by default; `true` exposes a matching funded, activated campaign. |
| `MEMEFUN_LAUNCH_REWARD_CONTRACT` | Actual deployed distributor address on the API's existing `MEMEFUN_CHAIN`. |
| `MEMEFUN_LAUNCH_REWARD_TOKEN` | Optional safety assertion of its immutable reward token; set it for production. |
| `MEMEFUN_LAUNCH_REWARD_TOKEN_NAME` | Optional public display name, at most 80 characters; defaults to on-chain name. |
| `MEMEFUN_LAUNCH_REWARD_TOKEN_SYMBOL` | Optional public display symbol, at most 20 characters; defaults to on-chain symbol. |
| `MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY` | Dedicated secret matching `campaignSigner()`. No owner/keeper fallback. Keep a secure backup before funding. |
| `MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE` | Optional **assertion**: `true` refuses to expose a campaign whose on-chain trade rule is still off. It does not send an owner transaction. |
| `MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC` | Ticket lifetime, default 300 seconds, range 30–900. |

The chain remains authoritative for the token, raw payout, activation block, cap, funding and trade-rule boundary. Invalid configuration hides the feature or returns an unavailable response. Campaign failures do not switch ordinary trading into a preview mode.

## Enable the trade rule later

Confirm this decision before sending the owner's `enableTradeRequirement()` transaction: the change is irreversible. Wait for its receipt, read `tradeRequiredFromBlock()`, then optionally set `MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE=true` on the API. Restart it. The app automatically shows the rule for new launchers; earlier eligible wallets can still claim without making a trade. Environment flags cannot weaken an enabled on-chain rule.

## HTTP and operations

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/launch-campaign` | `{ enabled: false }` while unconfigured; otherwise token, exact reward, activation/trade blocks and allocation counts. |
| `GET /v1/launch-campaign/wallets/:address` | Launch required, confirming, trade required, eligible, claimed or full. |
| `POST /v1/launch-campaign/claim-ticket` | SIWE bearer session required. Recipient is the session wallet, never a request body address. |

Responses use `Cache-Control: no-store`; server chain reads are briefly cached, but ticket issuance refreshes them. PostgreSQL quotas are shared across API replicas. Tickets bind chain, distributor, wallet, slot, launch coin, evidence blocks and deadline. Refreshing or cancelling a ticket does not mark the wallet claimed; the on-chain successful claim does.

Discovery hiding of internal QA coins is moderation only. Existing token balances, direct token pages and earned claims remain available. User-created tokens are retained. Moderation never removes a campaign allocation.
