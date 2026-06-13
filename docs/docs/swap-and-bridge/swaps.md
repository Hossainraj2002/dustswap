# Swaps

The general-purpose token swap interface (`/swap`) lets you trade tokens on Base. It is separate from [DustSweep](../dustsweep/what-is-dustsweep.md), which is built specifically for clearing out small dust balances.

## How it works

The DustSwap swap experience is provided **in partnership with OpenOcean**, which aggregates routing across Base liquidity to find competitive prices. DustSwap's on-chain aggregator router applies DustSwap's fee (hard-capped on-chain at 3%) and sends your swap output to your wallet.

## User flow

1. Connect your wallet.
2. Pick the tokens and amount you want to swap.
3. Review the quote.
4. Approve the token (if this is the first time you're swapping it).
5. Confirm the swap in your wallet.
6. Your transaction is recorded and verified — your swap volume and Particle Points update on your profile.

## Rewards

Each verified swap earns **50 PP**, up to a daily cap of **500 PP**. Your streak boost applies — see [Streak Boost Explained](../rewards/streak-boost-explained.md). Swap volume also feeds the [Volume leaderboard](../leaderboards/leaderboard-overview.md).

## Fees & security

See [Swap & Bridge Fees](fees.md) and [Swap & Bridge Security](security.md).

## Limitations

- Base only.
- To be confirmed before publication: the exact live swap fee percentage shown to users.
- To be confirmed before publication: whether swaps made outside the DustSwap app can earn PP.

## Related pages

- [PP Rewards](../rewards/pp-rewards.md)
- [Leaderboard Overview](../leaderboards/leaderboard-overview.md)
- [Bridge](bridge.md)
