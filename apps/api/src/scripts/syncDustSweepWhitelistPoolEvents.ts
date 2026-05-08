import dotenv from "dotenv";
dotenv.config();

import { syncWhitelistFromPoolEventsDexScreener } from "../routes/dustsweep";

function getArg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function getOptionalNumberArg(name: string) {
  const value = getArg(name, "");
  return value === "" ? undefined : Number(value);
}

function getBoolArg(name: string, fallback = false) {
  const value = getArg(name, String(fallback)).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

async function main() {
  const result = await syncWhitelistFromPoolEventsDexScreener({
    fromBlock: getOptionalNumberArg("fromBlock"),
    toBlock: getOptionalNumberArg("toBlock"),
    blockStep: Math.max(1_000, Math.min(250_000, Number(getArg("blockStep", "50000")))),
    maxTokens: Math.max(1, Math.min(50_000, Number(getArg("maxTokens", "50000")))),
    minLiquidityUSD: Math.max(0, Number(getArg("minLiquidityUSD", process.env.DUST_SWEEP_WHITELIST_MIN_LIQUIDITY_USD || "1000"))),
    replaceActive: getBoolArg("replaceActive", false),
    delayMs: Math.max(0, Math.min(5000, Number(getArg("delayMs", process.env.DUST_SWEEP_POOL_EVENT_SYNC_DELAY_MS || "150")))),
  });

  console.log(JSON.stringify({ success: true, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
