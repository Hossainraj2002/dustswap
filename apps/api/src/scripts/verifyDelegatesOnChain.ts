/**
 * Read-only EIP-7702 delegate verification across chains.
 *
 * For each known wallet-brand delegate, reads eth_getCode on Base (8453) and Ethereum (1) and
 * reports whether the implementation contract is present and whether the code hash matches across
 * chains (CREATE2-deterministic delegates deploy to the same address with identical code).
 *
 * Run:  pnpm --filter @dustswap/api exec tsx src/scripts/verifyDelegatesOnChain.ts
 *   (or) npx tsx apps/api/src/scripts/verifyDelegatesOnChain.ts
 *
 * Optional env overrides:  BASE_MAINNET_RPC_URL, ETHEREUM_MAINNET_RPC_URL
 *
 * NEVER wire this into CI — it makes live RPC calls. Paste its output into the multichain PR so
 * the KNOWN_DELEGATES mainnet coverage is auditable. Keep the list below in sync with
 * apps/web/src/lib/eip7702.ts (KNOWN_DELEGATES wallet-brand entries).
 */

import { createPublicClient, http, keccak256, type Address } from "viem";
import { base, mainnet } from "viem/chains";

// Wallet-brand delegates worth verifying on mainnet (labels only — mirror of KNOWN_DELEGATES).
const DELEGATES: Array<{ wallet: string; address: Address }> = [
  { wallet: "metamask", address: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b" },
  { wallet: "okx (base)", address: "0xe40ccb2d94975c51bff0c004efdfd9b3a5796fa4" },
  { wallet: "okx (mainnet)", address: "0x80296ff8d1ed46f8e3c7992664d13b833504c2bb" },
  { wallet: "base_account", address: "0x7702cb554e6bfb442cb743a7df23154544a7176c" },
  { wallet: "tokenpocket", address: "0xcc0c946eecf01a4bc76bc333ea74ceb04756f17b" },
  { wallet: "ambire", address: "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d" },
  { wallet: "trust", address: "0xd2e28229f6f2c235e57de2ebc727025a1d0530fb" },
  { wallet: "uniswap-1", address: "0x000000009b1d0af20d8c6d0a44e162d11f9b8f00" },
  { wallet: "uniswap-2", address: "0x0c338ca25585035142a9a0a1eeeba267256f281f" },
  { wallet: "uniswap-3", address: "0x458f5a9f47a01bea5d7a32662660559d9ed3312c" },
  { wallet: "bitget-1", address: "0xa845c74344fc9405b1fcf712f04668979573c1bf" },
  { wallet: "bitget-2", address: "0x4428a93b478fa76a5bd9c7641f54ec6373855433" },
  { wallet: "rainbow", address: "0x612373d7003d694220f7800eeaf8e3924c0951d3" },
];

async function main() {
  const baseClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org"),
  });
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com"),
  });

  console.log("wallet".padEnd(18), "present@8453", "present@1", "codeHashEqual");
  console.log("-".repeat(60));

  for (const { wallet, address } of DELEGATES) {
    const [baseCode, ethCode] = await Promise.all([
      baseClient.getCode({ address }).catch(() => undefined),
      ethClient.getCode({ address }).catch(() => undefined),
    ]);
    const basePresent = Boolean(baseCode && baseCode !== "0x");
    const ethPresent = Boolean(ethCode && ethCode !== "0x");
    const equal =
      basePresent && ethPresent ? keccak256(baseCode!) === keccak256(ethCode!) : false;
    console.log(
      wallet.padEnd(18),
      String(basePresent).padEnd(12),
      String(ethPresent).padEnd(9),
      String(equal),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
