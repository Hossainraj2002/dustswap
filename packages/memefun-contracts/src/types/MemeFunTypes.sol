// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Where the non-platform part of a coin's fee goes. Chosen at launch, immutable after.
/// @dev Order matches MODE_INDEX in apps/memefun/src/lib/admin/ownerCalls.ts.
enum Mode {
    /// The creator earns it all.
    CREATOR,
    /// Fees buy the coin back from its own pool and send it to 0x...dEaD.
    BURN,
    /// Fees are paid out to holders by epoch.
    HOLDERS,
    /// Fees become permanent buy-side liquidity under the price.
    FLOOR
}

/// @notice Kind of pair asset. Each kind can be switched off for new launches as a whole.
/// @dev Order matches KIND_INDEX in apps/memefun/src/lib/admin/ownerCalls.ts.
enum QuoteKind {
    NATIVE,
    STABLE,
    STOCK,
    /// Other owner-listed crypto assets, priced in USD rather than assumed to be stablecoins.
    /// Appended so existing native/stable/stock event and storage indices remain unchanged.
    TOKEN
}

/// @notice How the USD price of a quote is read when a new coin's opening price is set.
enum PriceSource {
    /// A constant, e.g. $1 for USDC.
    FIXED,
    /// A Chainlink aggregator with a maximum age.
    CHAINLINK,
    /// Set by the price keeper within bounds, e.g. a tokenized stock's NAV.
    MANUAL
}
