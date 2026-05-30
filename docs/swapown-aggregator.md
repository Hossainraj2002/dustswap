# DustSwap `/swapown` Aggregator

`/swapown` is additive. It does not replace `/swap`, and the current OpenOcean
widget/capture flow should keep working unchanged.

## Runtime Flow

- The web app quotes through `POST /api/swapown/quote`.
- The API uses direct DEX router/quoter sources only. Do not configure OpenOcean,
  0x, LI.FI, or other meta-aggregator execution targets as `/swapown` sources.
- The web app builds calldata through `POST /api/swapown/build-tx`.
- Users approve the deployed `DustSwapAggregatorRouter`, then call a readable
  function name: `swap` for single-output swaps or `swapBasket` for baskets.
- After confirmation, the web app calls the existing `POST /api/swaps/record`
  route. That route now also decodes DustSwap router events and writes to the
  existing swap volume tables, so swap volume/count quests continue to work from
  the current quest system.

## Deployment Checklist

1. Deploy `DustSwapAggregatorRouter` once per launch chain.
2. Configure at least 15 active direct sources per chain and allowlist each
   direct router target/spender on the deployed router.
3. Set API envs:
   - `DUSTSWAP_AGGREGATOR_ROUTER_BASE`
   - `DUSTSWAP_AGGREGATOR_ROUTER_ETHEREUM`
   - `DUSTSWAP_AGGREGATOR_ROUTER_BSC`
   - `DUSTSWAP_AGGREGATOR_ROUTER_POLYGON`
   - `DUSTSWAP_AGGREGATOR_ROUTER_ARBITRUM`
   - `DUSTSWAP_AGGREGATOR_ROUTER_AVALANCHE`
4. Run `GET /api/swapown/sources` and confirm each launch chain reports
   `productionReady: true`.
5. Verify contract source/ABI on each block explorer. This is what makes
   explorers show readable function names like `swap`, `approve`, and
   `swapBasket` instead of raw selectors.
6. Submit explorer label/profile metadata where supported:
   - Contract/project name: `DustSwap`
   - Contract source name: `DustSwapAggregatorRouter`
   - Logo asset: web app `/public/logo.png`

Explorer logo and label display is controlled by each explorer, so verification
and label submission are required but cannot force instant UI updates.
