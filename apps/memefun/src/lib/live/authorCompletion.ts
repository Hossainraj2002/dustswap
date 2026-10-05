import { ApiError, type ApiClient } from "./api";

export interface VerifiedAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  verifiedAt: string;
}

interface CallbackBrowser {
  location: { hash: string; pathname: string; search: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
}

export type CompletionResult = { state: "none" | "waiting" } | { state: "completed"; author: VerifiedAuthor };
const COMPLETION_LIFETIME_MS = 5 * 60_000;

/** Strip the credential before any authenticated work. It is never copied into storage. */
export function captureAuthorCompletion(browser?: CallbackBrowser): string | null {
  if (!browser?.location?.hash || !browser.history?.replaceState) return null;
  const fragment = new URLSearchParams(browser.location.hash.slice(1));
  const values = fragment.getAll("authorCompletion");
  if (!values.length) return null;
  fragment.delete("authorCompletion");
  const remaining = fragment.toString();
  browser.history.replaceState(browser.history.state, "", `${browser.location.pathname}${browser.location.search}${remaining ? `#${remaining}` : ""}`);
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
}

/** A failed redirect carries no identity or credentials; show one retry message. */
export function consumeAuthorConnectionFailure(browser?: CallbackBrowser): boolean {
  if (!browser?.location?.search || !browser.history?.replaceState) return false;
  const query = new URLSearchParams(browser.location.search);
  if (query.get("authorLinked") !== "0") return false;
  query.delete("authorLinked");
  const remaining = query.toString();
  browser.history.replaceState(browser.history.state, "", `${browser.location.pathname}${remaining ? `?${remaining}` : ""}${browser.location.hash}`);
  return true;
}

/** One callback credential, one request at a time, and no wallet prompts. */
export class AuthorCompletion {
  private token: string | null;
  private readonly capturedAt: number;
  private readonly blockedWallets = new Set<string>();
  private flight: { wallet: string; promise: Promise<CompletionResult> } | null = null;

  constructor(private readonly api: ApiClient, private readonly now: () => number, browser?: CallbackBrowser) {
    this.token = captureAuthorCompletion(browser);
    this.capturedAt = now();
  }

  hasPending(): boolean {
    if (this.token && this.now() - this.capturedAt >= COMPLETION_LIFETIME_MS) this.token = null;
    return this.token !== null;
  }

  async complete(wallet: string, bearer: string): Promise<CompletionResult> {
    if (!this.hasPending()) return { state: "none" };
    if (!bearer) return { state: "waiting" };
    const key = wallet.toLowerCase();
    if (this.blockedWallets.has(key)) return { state: "waiting" };
    if (this.flight) {
      if (this.flight.wallet === key) return this.flight.promise;
      await this.flight.promise;
      return this.complete(wallet, bearer);
    }
    const token = this.token!;
    const promise = this.api.post<{ author: VerifiedAuthor }>("/v1/author/complete", { token }, { token: bearer })
      .then(({ author }): CompletionResult => { this.token = null; return { state: "completed", author }; })
      .catch((error: unknown): CompletionResult => {
        if (error instanceof ApiError && error.code === "x_oauth_completion_wallet_mismatch") {
          this.blockedWallets.add(key);
          return { state: "waiting" };
        }
        if (error instanceof ApiError && ["x_oauth_completion_expired", "x_oauth_completion_invalid", "invalid_request"].includes(error.code)) {
          this.token = null;
          return { state: "none" };
        }
        throw error;
      });
    this.flight = { wallet: key, promise };
    try { return await promise; }
    finally { if (this.flight?.promise === promise) this.flight = null; }
  }
}
