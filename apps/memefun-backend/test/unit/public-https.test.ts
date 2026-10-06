import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadUri, resolveMetadata } from "../../keeper/jobs/metadata";
import { FetchRejected, fetchPublicHttps, isPublicAddress, type HttpsDependencies } from "../../lib/media/public-https";
import type { MediaStore } from "../../lib/media/store";
import { fakeHttps } from "./https-fixture";

const media = { get: vi.fn(async () => null), put: vi.fn() } as unknown as MediaStore;
afterEach(() => { vi.restoreAllMocks(); });

describe("untrusted HTTPS metadata destinations", () => {
  it.each([
    "127.0.0.1", "0.0.0.0", "10.0.0.8", "100.64.0.1", "172.16.4.5", "192.168.1.1", "169.254.169.254",
    "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "ff02::1",
    "64:ff9b::a00:1", "2002:a00:1::1", "2001::1", "2001:db8::1", "3fff::1", "not an address",
  ])("rejects nonpublic address %s", address => { expect(isPublicAddress(address)).toBe(false); });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700::1111", "2001:4860:4860::8888"])("permits public address %s", address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "https://127.1/meta.json", "https://2130706433/meta.json", "https://0x7f000001/meta.json",
    "https://0177.0.0.1/meta.json", "https://%31%32%37.0.0.1/meta.json", "https://[::1]/meta.json",
    "https://[::ffff:127.0.0.1]/meta.json", "https://localhost./meta.json", "https://service.internal/meta.json",
    "https://example.com:8443/meta.json", "https://user:pass@example.com/meta.json", "http://example.com/meta.json",
  ])("refuses %s before opening a connection", async url => {
    const request = vi.fn(), resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    await expect(fetchPublicHttps(url, 1024, { request: request as HttpsDependencies["request"], resolve })).rejects.toBeInstanceOf(FetchRejected);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }],
    [{ address: "8.8.8.8", family: 6 }],
    [],
  ])("refuses unsafe or empty DNS answers %j", async (...answers) => {
    const request = vi.fn();
    await expect(fetchPublicHttps("https://coin.example/meta.json", 1024, {
      request: request as HttpsDependencies["request"], resolve: async () => answers as LookupAddress[],
    })).rejects.toBeInstanceOf(FetchRejected);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the validated address while retaining the original TLS hostname", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    resolver.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    resolver.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const base = fakeHttps(async () => new Response('{"description":"gm"}'));
    const observed: Array<unknown> = [];
    const request = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(url.hostname).toBe("coin.example");
      expect(options.agent).toBe(false);
      expect(options.family).toBe(4);
      expect(options.rejectUnauthorized).not.toBe(false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        options.lookup!(url.hostname, { family: 4 }, (error, address, family) => {
          expect(error).toBeNull(); observed.push([address, family]);
        });
      }
      return base.request!(url, options, callback);
    }) as HttpsDependencies["request"];
    const raw = await fetchPublicHttps("https://coin.example/meta.json", 1024, { resolve: resolver, request });
    expect(new TextDecoder().decode(raw)).toBe('{"description":"gm"}');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([["93.184.216.34", 4], ["93.184.216.34", 4]]);
  });

  it.each([301, 302, 307, 308])("never follows redirect status %i", async status => {
    const source = vi.fn(async () => new Response("", { status, headers: { location: "https://127.0.0.1/private" } }));
    await expect(fetchPublicHttps("https://coin.example/meta.json", 1024, fakeHttps(source))).rejects.toBeInstanceOf(FetchRejected);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("limits declared and streamed bytes, and rejects failed DNS without sending a request", async () => {
    await expect(fetchPublicHttps("https://coin.example/meta.json", 5, fakeHttps(async () => new Response("ok", { headers: { "content-length": "6" } })))).rejects.toThrow("too large");
    await expect(fetchPublicHttps("https://coin.example/meta.json", 5, fakeHttps(async () => new Response("123456")))).rejects.toThrow("too large");
    const request = vi.fn();
    await expect(fetchPublicHttps("https://coin.example/meta.json", 5, { resolve: async () => { throw new Error("DNS failed"); }, request: request as HttpsDependencies["request"] })).rejects.toThrow("DNS failed");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)("retains %s decoding while capping decompressed bytes", async (encoding, compress) => {
    const value = '{"description":"A public coin"}';
    const response = () => new Response(new Uint8Array(compress(Buffer.from(value))), { headers: { "content-encoding": encoding } });
    expect(new TextDecoder().decode(await fetchPublicHttps("https://coin.example/meta.json", 1024, fakeHttps(async () => response())))).toBe(value);
    await expect(fetchPublicHttps("https://coin.example/meta.json", 32, fakeHttps(async () => new Response(new Uint8Array(compress(Buffer.alloc(1024, 65))), { headers: { "content-encoding": encoding } })))).rejects.toThrow("too large");
  });

  it("caps chunked compressed wire bytes even when the decoded document is small", async () => {
    const value = '{"description":"small"}';
    const emptyMember = gzipSync(Buffer.alloc(0));
    const encoded = Buffer.concat([gzipSync(Buffer.from(value)), ...Array.from({ length: 5000 }, () => emptyMember)]);
    expect(encoded.byteLength).toBeGreaterThan(65_536);
    await expect(fetchPublicHttps("https://coin.example/meta.json", 65_536, fakeHttps(async () =>
      new Response(new Uint8Array(encoded), { headers: { "content-encoding": "gzip" } }), 1024,
    ))).rejects.toThrow("too large");
  });

  it("times out even when DNS never resolves", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const request = vi.fn();
    const pending = fetchPublicHttps("https://coin.example/meta.json", 5, {
      resolve: () => new Promise(() => undefined), request: request as HttpsDependencies["request"],
    });
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    expect(request).not.toHaveBeenCalled();
  });

  it("protects both contractURI and nested JSON image without dropping valid metadata", async () => {
    const source = vi.fn(async () => new Response(JSON.stringify({ description: "A real coin", image: "https://[::ffff:127.0.0.1]/private" })));
    const dependencies = fakeHttps(source);
    await expect(loadUri({ media }, "https://10.0.0.1/meta.json", 1024, dependencies)).rejects.toBeInstanceOf(FetchRejected);
    const resolved = await resolveMetadata({ media }, "https://coin.example/meta.json", dependencies);
    expect(resolved.doc.description).toBe("A real coin");
    expect(resolved.imageUri).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
  });
});
