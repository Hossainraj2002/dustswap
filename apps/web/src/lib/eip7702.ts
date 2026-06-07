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
  "0x80296ff8d1ed46f8e3c7992664d13b833504c2bb": {
    wallet: "okx",
    label: "OKX Wallet",
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

  // ── Known infra/service delegates (labels only — no wallet to switch to) ──
  "0x23e5f9c457a69ce776d20a8fe812a6701d66fce8": {
    wallet: "unknown",
    label: "Otim Delegator",
  },
  "0x69007702764179f14f51cdce752f4f775d74e139": {
    wallet: "unknown",
    label: "Alchemy Modular Account v2",
  },
  "0x000000004f43c49e93c970e84001853a70923b03": {
    wallet: "unknown",
    label: "Biconomy Nexus v1.2.0",
  },
  "0xe6cae83bde06e4c305530e199d7217f42808555b": {
    wallet: "unknown",
    label: "Pimlico Simple 7702 Account",
  },
};

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
