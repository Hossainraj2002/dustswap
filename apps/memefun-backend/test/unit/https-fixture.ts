import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { HttpsDependencies } from "../../lib/media/public-https";

/** Offline Node HTTPS transport; the production URL/DNS/connection guard still executes. */
export function fakeHttps(fetchResponse: typeof fetch, chunkSize?: number): HttpsDependencies {
  return {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: ((url: URL, options: { signal?: AbortSignal }, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = () => request;
      request.end = (() => {
        queueMicrotask(() => {
          void (async () => {
            try {
              const source = await fetchResponse(url, { signal: options.signal, redirect: "error" });
              const bytes = Buffer.from(await source.arrayBuffer());
              const chunks = chunkSize
                ? Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) => bytes.subarray(index * chunkSize, (index + 1) * chunkSize))
                : [bytes];
              const response = Readable.from(chunks) as IncomingMessage;
              response.statusCode = source.status;
              response.headers = Object.fromEntries(source.headers.entries());
              callback(response);
            } catch (error) {
              request.emit("error", error);
            }
          })();
        });
        return request;
      }) as ClientRequest["end"];
      return request;
    }) as HttpsDependencies["request"],
  };
}
