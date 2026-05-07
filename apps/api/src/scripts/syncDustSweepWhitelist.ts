import dotenv from "dotenv";
dotenv.config();

import { syncWhitelistFromGeckoTerminal } from "../routes/dustsweep";

function getArg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function getBoolArg(name: string, fallback = false) {
  const value = getArg(name, String(fallback)).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

async function main() {
  const result = await syncWhitelistFromGeckoTerminal({
    maxPages: Math.max(1, Math.min(250, Number(getArg("maxPages", "200")))),
    maxTokens: Math.max(1, Math.min(5000, Number(getArg("maxTokens", "4000")))),
    minLiquidityUSD: Math.max(0, Number(getArg("minLiquidityUSD", process.env.DUST_SWEEP_WHITELIST_MIN_LIQUIDITY_USD || "1000"))),
    replaceActive: getBoolArg("replaceActive", false),
    delayMs: Math.max(0, Math.min(5000, Number(getArg("delayMs", process.env.DUST_SWEEP_WHITELIST_SYNC_DELAY_MS || "250")))),
  });

  console.log(JSON.stringify({ success: true, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
