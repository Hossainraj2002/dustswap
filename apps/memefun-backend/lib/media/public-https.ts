import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export class FetchRejected extends Error {}

const privateV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateV4.addSubnet(network, prefix, "ipv4");

const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const reservedV6 = new BlockList();
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  reservedV6.addSubnet(network, prefix, "ipv6");
}

/** Fail closed on local, reserved, mapped and IPv6 transition addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateV4.check(address, "ipv4");
  if (family === 6) return publicV6.check(address, "ipv6") && !reservedV6.check(address, "ipv6");
  return false;
}

export interface HttpsDependencies {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  request?: typeof httpsRequest;
}

async function resolveBeforeAbort(resolve: () => Promise<LookupAddress[]>, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    resolve().then(accept, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Untrusted coin metadata/image URLs: validate DNS and dial the same approved IP with TLS. */
export async function fetchPublicHttps(url: string, limit: number, dependencies: HttpsDependencies = {}): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new FetchRejected("only plain https URLs on port 443 are fetched");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (/^(?:localhost\.?|.*\.(?:localhost|local|internal|home\.arpa)\.?)$/i.test(hostname)) {
    throw new FetchRejected("metadata host is not public");
  }
  const signal = AbortSignal.timeout(8_000);
  const family = isIP(hostname);
  const addresses: LookupAddress[] = family
    ? [{ address: hostname, family }]
    : await resolveBeforeAbort(() => (dependencies.resolve ?? (host => dnsLookup(host, { all: true, verbatim: true })))(hostname), signal);
  if (!addresses.length || addresses.some(candidate => !isPublicAddress(candidate.address) || isIP(candidate.address) !== candidate.family)) {
    throw new FetchRejected("metadata host must resolve only to public addresses");
  }
  // Prefer IPv4 where available, but never resolve again between validation and connection.
  const selected = addresses.find(candidate => candidate.family === 4) ?? addresses[0]!;
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const request = (dependencies.request ?? httpsRequest)(parsed, {
      agent: false,
      family: selected.family,
      signal,
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
    }, response => {
      const status = response.statusCode ?? 0;
      let body: Readable = response;
      let refused = false;
      const refuse = (error: Error) => {
        if (refused) return;
        refused = true;
        if (body !== response) body.destroy();
        response.destroy();
        request.destroy();
        reject(error);
      };
      if (status >= 300 && status < 400) return refuse(new FetchRejected("metadata redirects are not followed"));
      if (status < 200 || status >= 300) return refuse(new Error(`HTTP ${status}`));
      if (Number(response.headers["content-length"] ?? 0) > limit) return refuse(new FetchRejected("too large"));
      const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      let wireSize = 0;
      response.on("data", (chunk: Buffer) => {
        wireSize += chunk.byteLength;
        if (wireSize > limit) refuse(new FetchRejected(`too large (over ${limit} wire bytes)`));
      });
      // Fetch previously decoded these formats. Bound decoded bytes as well as wire size.
      if (encoding === "gzip") body = response.pipe(createGunzip());
      else if (encoding === "deflate") body = response.pipe(createInflate());
      else if (encoding === "br") body = response.pipe(createBrotliDecompress());
      else if (encoding !== "identity") return refuse(new FetchRejected("unsupported metadata encoding"));
      const chunks: Buffer[] = [];
      let size = 0;
      body.on("data", (chunk: Buffer) => {
        if (refused) return;
        size += chunk.byteLength;
        if (size > limit) return refuse(new FetchRejected(`too large (over ${limit} bytes)`));
        chunks.push(chunk);
      });
      response.on("error", refuse);
      response.on("aborted", () => refuse(new Error("metadata response aborted")));
      body.on("error", refuse);
      body.on("end", () => { if (!refused) accept(new Uint8Array(Buffer.concat(chunks, size))); });
    });
    request.on("error", reject);
    request.end();
  });
}
