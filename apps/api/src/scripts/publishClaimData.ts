import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Publishes a built allocation to the R2 bucket the claim page reads from.
 *
 * Only ever writes under `--prefix` (default `claim/`), so it cannot disturb anything else in the
 * bucket. Uploads are immutable for a given Merkle root, so they are served with a long cache and
 * the page busts that cache by root.
 *
 * Activity totals (sweep volume, swap volume, streak saves) are STRIPPED by default. They are not
 * needed to check eligibility or to claim; they exist only to show a person their own numbers.
 * Putting 1,900 people's trading volumes on a public CDN is a one-way door, so it takes an
 * explicit --with-stats.
 *
 * Usage:
 *   ts-node src/scripts/publishClaimData.ts --dir "C:/Users/akbar/dustswap-reports/claim"
 *   ts-node src/scripts/publishClaimData.ts --dir <dir> --with-stats   (publishes the totals too)
 *   ts-node src/scripts/publishClaimData.ts --dir <dir> --dry-run
 */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = String(args.dir || "");
  const prefix = String(args.prefix || "claim").replace(/^\/+|\/+$/g, "");
  const withStats = Boolean(args["with-stats"]);
  const dryRun = Boolean(args["dry-run"]);

  if (!dir || !fs.existsSync(dir)) throw new Error("--dir must point at a built allocation");

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    throw new Error("R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
  }

  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  const index = JSON.parse(fs.readFileSync(path.join(dir, "eligibility.json"), "utf8"));

  if (index.root !== summary.root) throw new Error("summary.json and eligibility.json disagree on the root");

  const addresses = Object.keys(index.entries);
  const proofsDir = path.join(dir, "proofs");
  const files = fs.readdirSync(proofsDir).filter((f) => f.endsWith(".json"));
  if (files.length !== addresses.length) {
    throw new Error(`${addresses.length} addresses but ${files.length} proof files`);
  }

  console.log(`root        ${summary.root}`);
  console.log(`total       ${summary.totalAllocationUsd} USDC`);
  console.log(`addresses   ${addresses.length}`);
  console.log(`bucket      ${bucket}`);
  console.log(`prefix      ${prefix}/`);
  console.log(`public base ${publicBase}`);
  console.log(`stats       ${withStats ? "INCLUDED (publishes per-user trading volumes)" : "stripped"}`);

  if (dryRun) {
    console.log("\n--dry-run, nothing uploaded.");
    return;
  }

  const s3 = new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  // Immutable per root; the page appends ?v=<root> so a new list never serves stale proofs.
  const CACHE = "public, max-age=31536000, immutable";

  const put = async (key: string, body: string) =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        CacheControl: CACHE,
      })
    );

  await put(`${prefix}/eligibility.json`, JSON.stringify(index));
  console.log(`\nuploaded ${prefix}/eligibility.json`);

  let done = 0;
  const CONC = 12;
  let next = 0;
  async function worker() {
    for (;;) {
      const k = next++;
      if (k >= files.length) return;
      const file = files[k];
      const raw = JSON.parse(fs.readFileSync(path.join(proofsDir, file), "utf8"));
      const body = withStats
        ? raw
        : { i: raw.i, a: raw.a, p: raw.p };
      await put(`${prefix}/proofs/${file}`, JSON.stringify(body));
      if (++done % 100 === 0) process.stdout.write(`\ruploaded proofs ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(`\ruploaded proofs ${done}/${files.length}\n`);

  console.log(`\nNEXT_PUBLIC_CLAIM_DATA_URL=${publicBase}/${prefix}`);
  console.log(`check: ${publicBase}/${prefix}/eligibility.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
