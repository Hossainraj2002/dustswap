import { type Address } from "viem";
import {
  type DelegateIdentity,
  type DustSweepWalletKey,
} from "@/types/dustsweep";

// EIP-7702 delegation designator prefix. A delegated EOA's code is
// `0xef0100 || <20-byte delegate address>`. See EIP-7702 + Privy's guide
// (docs/eip7702-delegation-aware-workflow.md §2).
const DELEGATION_DESIGNATOR_PREFIX = "0xef0100";

/**
 * Returns the delegate (implementation) address an EOA points to on the chain
 * the code was read from, or null when the account is a plain EOA / ordinary
 * contract. Authorization state is per-chain, so always read code on Base.
 */
export function parseEip7702AuthorizedAddress(
  code?: string | null,
): Address | null {
  if (!code || code === "0x" || code === "0x0") {
    return null; // not delegated (plain EOA)
  }

  const lowered = code.toLowerCase();
  const idx = lowered.indexOf(DELEGATION_DESIGNATOR_PREFIX);
  if (idx === -1) {
    return null; // some other contract code, not a 7702 delegation
  }

  const start = idx + DELEGATION_DESIGNATOR_PREFIX.length;
  const delegate = lowered.slice(start, start + 40);
  if (delegate.length < 40) {
    return null; // malformed designator
  }

  return `0x${delegate}` as Address;
}

export type DelegateRegistryEntry = {
  wallet: DustSweepWalletKey;
  label: string;
};

/**
 * Self-curated map of delegate (implementation) contract addresses → wallet.
 * There is no canonical public registry, so we maintain our own and grow it via
 * telemetry (any "unknown" delegate seen in the wild gets logged per sweep).
 *
 * This map is LABELS ONLY — it never gates anything. The wallet's atomic
 * capability is the gate; an out-of-date or missing entry degrades to Route C
 * (Permit2), never to a block. Entries with `wallet: "unknown"` are recognized
 * infra delegates we can name but cannot offer a "switch to" action for.
 *
 * Keys MUST be lowercase. Seed wallet-brand entries by connecting each wallet,
 * running one batch (so it performs its 7702 upgrade), then reading
 * eth_getCode on Base and recording the delegate address here.
 */
export const KNOWN_DELEGATES: Record<string, DelegateRegistryEntry> = {
  // ── Wallet-brand delegates (verified deployed on Base 8453) ──
  // These EIP-7702 delegate implementations deploy deterministically (same
  // address across EVM chains via CREATE2). Each below was confirmed to exist on
  // Base; MetaMask/Ambire/Trust are verified source, OKX is unverified but the
  // same contract+creator as the Etherscan-labeled "OKX: EIP-7702 Delegator".
  // To add/override without a redeploy, use NEXT_PUBLIC_EXTRA_KNOWN_DELEGATES.
  // Capture a real address in-app via the route chip's "Why?" (prints the
  // detected "Delegated to: 0x…") or the per-sweep route telemetry.
  "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b": {
    wallet: "metamask",
    label: "MetaMask Smart Account",
  },
  // OKX's actual Base delegate is its SmartWalletEntry — VERIFIED two ways:
  // (1) read from a live OKX-delegated Base account (eth_getCode → 0xef0100…),
  // (2) OKX's official okxlabs/okx-smart-wallet-evm repo lists this exact
  // SmartWalletEntry address as deployed on Base. BaseScan leaves it unlabeled,
  // which is why scraping Etherscan's mainnet "OKX: EIP-7702 Delegator" label
  // gave the wrong (mainnet-only) address below.
  "0xe40ccb2d94975c51bff0c004efdfd9b3a5796fa4": {
    wallet: "okx",
    label: "OKX Wallet",
  },
  // OKX's mainnet delegator label (kept as OKX; harmless if some accounts use it).
  "0x80296ff8d1ed46f8e3c7992664d13b833504c2bb": {
    wallet: "okx",
    label: "OKX Wallet",
  },
  "0x7702cb554e6bfb442cb743a7df23154544a7176c": {
    wallet: "base_account",
    label: "Base Account / Coinbase Wallet",
  },
  // TokenPocket EIP-7702 delegate. Verified from:
  // - Base eth_getCode on a live TokenPocket-upgraded account:
  //   0xB4Cc...df470 -> 0xef0100cc0c946eecf01a4bc76bc333ea74ceb04756f17b
  // - Etherscan label/source: "TokenPocket: EIP-7702 Delegator" /
  //   TokenPocketSimple7702Account.
  "0xcc0c946eecf01a4bc76bc333ea74ceb04756f17b": {
    wallet: "tokenpocket",
    label: "TokenPocket Wallet",
  },
  "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d": {
    wallet: "ambire",
    label: "Ambire Wallet",
  },
  "0xd2e28229f6f2c235e57de2ebc727025a1d0530fb": {
    wallet: "trust",
    label: "Trust Wallet",
  },
  "0x000000009b1d0af20d8c6d0a44e162d11f9b8f00": {
    wallet: "uniswap",
    label: "Uniswap Wallet",
  },
  "0x0c338ca25585035142a9a0a1eeeba267256f281f": {
    wallet: "uniswap",
    label: "Uniswap Wallet",
  },
  "0x458f5a9f47a01bea5d7a32662660559d9ed3312c": {
    wallet: "uniswap",
    label: "Uniswap Wallet",
  },
  "0xa845c74344fc9405b1fcf712f04668979573c1bf": {
    wallet: "bitget",
    label: "Bitget Wallet",
  },
  "0x4428a93b478fa76a5bd9c7641f54ec6373855433": {
    wallet: "bitget",
    label: "Bitget Wallet",
  },
  "0x612373d7003d694220f7800eeaf8e3924c0951d3": {
    wallet: "rainbow",
    label: "Rainbow",
  },

  // ── Known infra/service delegates (labels only — no wallet to switch to) ──
  "0x4cd241e8d1510e30b2076397afc7508ae59c66c9": {
    wallet: "unknown",
    label: "Ethereum Foundation AA Delegator",
  },
  "0x17c11fddadac2b341f2455afe988fec4c3ba26e3": {
    wallet: "unknown",
    label: "Luganodes Batch Contract",
  },
  "0x23e5f9c457a69ce776d20a8fe812a6701d66fce8": {
    wallet: "unknown",
    label: "Otim Delegator",
  },
  "0x5af42746a8af42d8a4708df238c53f1f71abf0e0": {
    wallet: "unknown",
    label: "Gelato",
  },
  "0xcda3577ca7ef65f6b7201e9bd80375f5628d15f7": {
    wallet: "unknown",
    label: "WhiteBit Account",
  },
  "0x79cf9e04ad9aeb210768c22c228673aed6cd24c4": {
    wallet: "unknown",
    label: "WhiteBit Account",
  },
  "0x4b3a543dc60a09974007d6937cd952e3a0188929": {
    wallet: "unknown",
    label: "WhiteBit Account",
  },
  "0x69007702764179f14f51cdce752f4f775d74e139": {
    wallet: "unknown",
    label: "Alchemy Modular Account v2",
  },
  "0x000000001964d23c59962fc7a912872ee8fb3b6a": {
    wallet: "unknown",
    label: "Biconomy Nexus",
  },
  "0x0000000020fe2f30453074ad916edeb653ec7e9d": {
    wallet: "unknown",
    label: "Biconomy Nexus",
  },
  "0x00000000383e8cbe298514674ea60ee1d1de50ac": {
    wallet: "unknown",
    label: "Biconomy Nexus",
  },
  "0x000000004f43c49e93c970e84001853a70923b03": {
    wallet: "unknown",
    label: "Biconomy Nexus v1.2.0",
  },
  "0x000000ac74357bfea72bbd0781833631f732cf19": {
    wallet: "unknown",
    label: "Biconomy Nexus",
  },
  "0xbac7e770af15d130cd72838ff386f14fbf3e9a3d": {
    wallet: "unknown",
    label: "Thirdweb",
  },
  "0xd6999651fc0964b9c6b444307a0ab20534a66560": {
    wallet: "unknown",
    label: "Thirdweb",
  },
  "0x4670d851672cb6e3ab4faea0a18dc08edea01d5e": {
    wallet: "unknown",
    label: "Thirdweb",
  },
  "0x3e515544f8d8293b0a353e10ff3b7ca03b52f35b": {
    wallet: "unknown",
    label: "Thirdweb",
  },
  "0xd6cedde84be40893d153be9d467cd6ad37875b28": {
    wallet: "unknown",
    label: "ZeroDev",
  },
  "0x664ab8c20b629422f5398e58ff8989e68b26a4e6": {
    wallet: "unknown",
    label: "Porto",
  },
  "0x8c0466a6c046395c8999227b288883cf7dc9f5de": {
    wallet: "unknown",
    label: "Porto",
  },
  "0xb292da8879c26ecd558bbea87f581cdd608ffc3c": {
    wallet: "unknown",
    label: "Porto",
  },
  "0x5874f358359ee96d2b3520409018f1a6f59a2cdc": {
    wallet: "unknown",
    label: "Porto",
  },
  "0x0000fb7702036ff9f76044a501ac1aa74cbab16b": {
    wallet: "unknown",
    label: "Fireblocks",
  },
  "0x7785a22facd31db653ba4928f1d5b81d093f0b2f": {
    wallet: "unknown",
    label: "Cordial",
  },
  "0xcea43594f38316f0e01c161d8dabde0a07a1f512": {
    wallet: "unknown",
    label: "Dfns",
  },
  "0xe6cae83bde06e4c305530e199d7217f42808555b": {
    wallet: "unknown",
    label: "Pimlico Simple 7702 Account",
  },
};

export const ONE_CLICK_SWEEP_WALLETS: Array<{
  wallet: DustSweepWalletKey;
  label: string;
  delegateAddresses: Address[];
}> = [
  {
    wallet: "okx",
    label: "OKX Wallet",
    delegateAddresses: [
      "0xe40ccb2d94975c51bff0c004efdfd9b3a5796fa4",
      "0x80296ff8d1ed46f8e3c7992664d13b833504c2bb",
    ] as Address[],
  },
  {
    wallet: "tokenpocket",
    label: "TokenPocket Wallet",
    delegateAddresses: [
      "0xcc0c946eecf01a4bc76bc333ea74ceb04756f17b",
    ] as Address[],
  },
  {
    wallet: "metamask",
    label: "MetaMask",
    delegateAddresses: [
      "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b",
    ] as Address[],
  },
  {
    wallet: "base_account",
    label: "Base Account",
    delegateAddresses: [
      "0x7702cb554e6bfb442cb743a7df23154544a7176c",
    ] as Address[],
  },
  {
    wallet: "coinbase",
    label: "Coinbase Wallet",
    delegateAddresses: [
      "0x7702cb554e6bfb442cb743a7df23154544a7176c",
    ] as Address[],
  },
  {
    wallet: "trust",
    label: "Trust Wallet",
    delegateAddresses: [
      "0xd2e28229f6f2c235e57de2ebc727025a1d0530fb",
    ] as Address[],
  },
  {
    wallet: "uniswap",
    label: "Uniswap Wallet",
    delegateAddresses: [
      "0x000000009b1d0af20d8c6d0a44e162d11f9b8f00",
      "0x0c338ca25585035142a9a0a1eeeba267256f281f",
      "0x458f5a9f47a01bea5d7a32662660559d9ed3312c",
    ] as Address[],
  },
  {
    wallet: "bitget",
    label: "Bitget Wallet",
    delegateAddresses: [
      "0xa845c74344fc9405b1fcf712f04668979573c1bf",
      "0x4428a93b478fa76a5bd9c7641f54ec6373855433",
    ] as Address[],
  },
  {
    wallet: "rainbow",
    label: "Rainbow",
    delegateAddresses: [
      "0x612373d7003d694220f7800eeaf8e3924c0951d3",
    ] as Address[],
  },
  {
    wallet: "ambire",
    label: "Ambire Wallet",
    delegateAddresses: [
      "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d",
    ] as Address[],
  },
];

export function getOneClickSweepWalletLabels(limit = 4) {
  return ONE_CLICK_SWEEP_WALLETS.slice(0, limit).map((wallet) => wallet.label);
}

export function isSameEip7702WalletFamily(
  a?: DustSweepWalletKey | null,
  b?: DustSweepWalletKey | null,
) {
  if (!a || !b) return false;
  if (a === b) return true;
  const coinbaseFamily = new Set<DustSweepWalletKey>(["base_account", "coinbase"]);
  return coinbaseFamily.has(a) && coinbaseFamily.has(b);
}

/**
 * Extra delegates injected via env so we can seed addresses captured in the
 * wild (e.g. OKX's Base delegate) WITHOUT a code deploy. Set
 * NEXT_PUBLIC_EXTRA_KNOWN_DELEGATES to a JSON object of
 *   { "0xlowercaseDelegate": { "wallet": "okx", "label": "OKX Wallet" } }
 * Parsed once at module load; malformed JSON is ignored (never throws).
 */
function parseExtraDelegates(): Record<string, DelegateRegistryEntry> {
  const raw = process.env.NEXT_PUBLIC_EXTRA_KNOWN_DELEGATES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, DelegateRegistryEntry>;
    const out: Record<string, DelegateRegistryEntry> = {};
    for (const [addr, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.wallet === "string" && typeof entry.label === "string") {
        out[addr.toLowerCase()] = entry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const EXTRA_KNOWN_DELEGATES = parseExtraDelegates();

/**
 * Resolves a delegate address to a human-friendly identity for messaging.
 * - null delegate → { state: "none" } (plain EOA)
 * - known delegate → { state: "known", wallet, label }
 * - unrecognized delegate → { state: "unknown", delegate }
 */
export function identifyDelegate(delegate: Address | null): DelegateIdentity {
  if (!delegate) {
    return { state: "none" };
  }

  const key = delegate.toLowerCase();
  const hit = KNOWN_DELEGATES[key] ?? EXTRA_KNOWN_DELEGATES[key];
  if (hit) {
    return { state: "known", wallet: hit.wallet, label: hit.label };
  }

  return { state: "unknown", delegate };
}
