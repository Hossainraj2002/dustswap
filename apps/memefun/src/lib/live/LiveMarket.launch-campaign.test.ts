import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { LaunchCampaignClaimTicket, LaunchCampaignSummary } from "@/core/campaign";
import { TxError } from "@/lib/market/Market";
import { ApiError, createApi } from "./api";
import { LiveMarket } from "./LiveMarket";
import { clearSession, loadSession, saveSession, signIn } from "./session";
import { sendLaunchCampaignClaim, type TxContext } from "./tx";

vi.mock("./session", () => ({ loadSession: vi.fn(), clearSession: vi.fn(), saveSession: vi.fn(), signIn: vi.fn() }));
vi.mock("./tx", () => ({ sendLaunchCampaignClaim: vi.fn() }));

const USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const CURRENT = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const SUMMARY: Extract<LaunchCampaignSummary, { enabled: true }> = {
  enabled: true, chainId: 8453, contract: CONTRACT,
  token: { address: CURRENT, name: "Campaign token", symbol: "MFT", decimals: 18 },
  rewardAmountRaw: "1000000000000000000", maxRecipients: 1000,
  claimedCount: 0, qualifiedCount: 1, startBlock: "100", tradeRequiredFromBlock: "0",
};
const TICKET: LaunchCampaignClaimTicket = {
  wallet: USER, slot: 0, coin: CURRENT, launchBlock: "101", tradeBlock: "0", deadline: 2_000_000_000,
  signature: `0x${"11".repeat(65)}`,
};
const session = (token: string) => ({ address: USER, token, expiresAt: Date.now() + 600_000 });
type Handler = (path: string, init?: RequestInit) => { status?: number; body: unknown };
function market(handler: Handler) {
  const events: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    events.push(path);
    const { status = 200, body } = handler(path, init);
    return new Response(JSON.stringify(body), { status });
  });
  const ctx = { wallet: { account: { address: USER } } } as unknown as TxContext;
  const txContext = vi.fn(async () => ctx);
  const api = createApi("https://campaign.test", fetch);
  const m = new LiveMarket({ api, client: {} as PublicClient, txContext,
    location: { host: "memefun.test", origin: "https://memefun.test" } });
  return { m, fetch, txContext, ctx, events, api };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadSession).mockReturnValue(session("test-only-cached-session"));
  vi.mocked(signIn).mockResolvedValue(session("test-only-refreshed-session"));
  vi.mocked(sendLaunchCampaignClaim).mockResolvedValue(HASH);
});

describe("LiveMarket campaign claim boundaries", () => {
  it("treats an older API's 404 as disabled without sign-in or a wallet request", async () => {
    const { m, fetch, txContext } = market(() => ({ status: 404, body: { error: { code: "not_found", message: "Not found" } } }));
    expect(await m.readLaunchCampaign()).toEqual({ enabled: false });
    await expect(m.claimLaunchCampaign(USER)).rejects.toThrow("campaign is not active");
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname === "/v1/launch-campaign")).toBe(true);
    expect(loadSession).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(txContext).not.toHaveBeenCalled();
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("fetches a fresh direct summary and authenticated empty-body ticket before the attributed claim helper", async () => {
    let active = SUMMARY;
    const { m, fetch, ctx, events, txContext } = market(path => {
      if (path === "/v1/launch-campaign") return { body: active };
      if (path === "/v1/launch-campaign/claim-ticket") return { body: TICKET };
      throw new Error(`Unexpected endpoint ${path}`);
    });
    expect(await m.readLaunchCampaign()).toEqual(SUMMARY);
    active = { ...SUMMARY, contract: CURRENT, qualifiedCount: 2 };
    const onStage = vi.fn();
    vi.mocked(sendLaunchCampaignClaim).mockImplementationOnce(async () => { events.push("chain-submit"); return HASH; });
    await expect(m.claimLaunchCampaign(USER, onStage)).resolves.toBe(HASH);
    expect(sendLaunchCampaignClaim).toHaveBeenCalledWith(ctx, active, TICKET);
    expect(txContext).toHaveBeenCalledWith(USER, onStage);
    const post = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/claim-ticket"))!;
    expect(post[1]?.method).toBe("POST");
    expect(post[1]?.body).toBe("{}");
    expect(new Headers(post[1]?.headers).get("authorization")).toBe("Bearer test-only-cached-session");
    expect(events).toEqual(["/v1/launch-campaign", "/v1/launch-campaign", "/v1/launch-campaign/claim-ticket", "chain-submit"]);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("retries a ticket's 401 exactly once after SIWE refresh and only before chain submission", async () => {
    let posts = 0;
    vi.mocked(loadSession).mockReturnValueOnce(session("test-only-expired-session")).mockReturnValue(null);
    const { m, fetch, events, api, ctx } = market(path => {
      if (path === "/v1/launch-campaign") return { body: SUMMARY };
      if (path === "/v1/launch-campaign/claim-ticket") {
        posts++;
        if (posts === 1) return { status: 401, body: { error: { code: "sign_in_required", message: "Sign in again" } } };
        return { body: TICKET };
      }
      throw new Error(`Unexpected endpoint ${path}`);
    });
    vi.mocked(signIn).mockImplementationOnce(async () => { events.push("sign-in"); return session("test-only-refreshed-session"); });
    vi.mocked(sendLaunchCampaignClaim).mockImplementationOnce(async () => { events.push("chain-submit"); return HASH; });
    await expect(m.claimLaunchCampaign(USER)).resolves.toBe(HASH);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledWith(USER);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(api, ctx.wallet, expect.any(Number), { host: "memefun.test", origin: "https://memefun.test" });
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ address: USER, token: "test-only-refreshed-session" }));
    expect(sendLaunchCampaignClaim).toHaveBeenCalledTimes(1);
    const ticketRequests = fetch.mock.calls.filter(([input]) => String(input).endsWith("/claim-ticket"));
    expect(ticketRequests).toHaveLength(2);
    expect(ticketRequests.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer test-only-expired-session", "Bearer test-only-refreshed-session"]);
    expect(events).toEqual(["/v1/launch-campaign", "/v1/launch-campaign/claim-ticket", "sign-in", "/v1/launch-campaign/claim-ticket", "chain-submit"]);
  });

  it("does not retry a non-authentication ticket failure or request a chain transaction", async () => {
    const { m, fetch, txContext } = market(path => path === "/v1/launch-campaign" ? { body: SUMMARY }
      : { status: 429, body: { error: { code: "campaign_request_quota", message: "Wait before requesting again" } } });
    await expect(m.claimLaunchCampaign(USER)).rejects.toMatchObject({ status: 429, code: "campaign_request_quota" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(clearSession).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(txContext).not.toHaveBeenCalled();
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it.each(["siwe_signature", "siwe_domain", "siwe_chain", "siwe_nonce"])("does not repeat fresh wallet sign-in after a %s verification rejection", async code => {
    vi.mocked(loadSession).mockReturnValue(null);
    const rejected = new ApiError(401, code, "Sign-in verification was rejected");
    vi.mocked(signIn).mockRejectedValue(rejected);
    const { m, fetch } = market(() => ({ body: SUMMARY }));
    await expect(m.claimLaunchCampaign(USER)).rejects.toBe(rejected);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(clearSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1); // No claim ticket was ever requested.
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("does not repeat a wallet's cancelled sign-in or request a claim ticket", async () => {
    vi.mocked(loadSession).mockReturnValue(null);
    const rejected = new TxError("You rejected the request in your wallet.", "rejected");
    vi.mocked(signIn).mockRejectedValue(rejected);
    const { m, fetch } = market(() => ({ body: SUMMARY }));
    await expect(m.claimLaunchCampaign(USER)).rejects.toBe(rejected);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(clearSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("does not retry a renewed sign-in that fails after the first ticket rejects its session", async () => {
    vi.mocked(loadSession).mockReturnValueOnce(session("test-only-expired-session")).mockReturnValue(null);
    const rejected = new ApiError(401, "siwe_signature", "The signature does not match this wallet.");
    vi.mocked(signIn).mockRejectedValue(rejected);
    const { m, fetch } = market(path => path === "/v1/launch-campaign" ? { body: SUMMARY }
      : { status: 401, body: { error: { code: "sign_in_required", message: "Sign in again" } } });
    await expect(m.claimLaunchCampaign(USER)).rejects.toBe(rejected);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("does not retry an unexpected ticket 401 by requesting another wallet signature", async () => {
    const { m, fetch, txContext } = market(path => path === "/v1/launch-campaign" ? { body: SUMMARY }
      : { status: 401, body: { error: { code: "siwe_domain", message: "This sign-in message is not for memefun." } } });
    await expect(m.claimLaunchCampaign(USER)).rejects.toMatchObject({ status: 401, code: "siwe_domain" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signIn).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(txContext).not.toHaveBeenCalled();
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("never asks for authentication or a transaction while campaign configuration is unavailable", async () => {
    const { m, fetch, txContext } = market(() => ({ status: 503,
      body: { error: { code: "campaign_unavailable", message: "The launch reward campaign is not active." } } }));
    await expect(m.claimLaunchCampaign(USER)).rejects.toMatchObject({ status: 503, code: "campaign_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(txContext).not.toHaveBeenCalled();
    expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
  });

  it("does not repeat a ticket request or reach the chain after its bounded HTTP request aborts", async () => {
    const controllers: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        if (String(input).endsWith("/v1/launch-campaign")) return Response.json(SUMMARY);
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
      });
      const txContext = vi.fn();
      const m = new LiveMarket({ api: createApi("https://campaign.test", fetch), client: {} as PublicClient, txContext });
      const claim = m.claimLaunchCampaign(USER);
      const failure = expect(claim).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(timeout.mock.calls).toEqual([[15_000], [15_000]]);
      controllers[1]!.abort(new DOMException("The request timed out.", "TimeoutError"));
      await failure;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signIn).not.toHaveBeenCalled();
      expect(txContext).not.toHaveBeenCalled();
      expect(sendLaunchCampaignClaim).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  it("propagates an ambiguous chain result with its hash and never reissues the ticket or transaction", async () => {
    const { m, fetch } = market(path => ({ body: path === "/v1/launch-campaign" ? SUMMARY : TICKET }));
    const ambiguous = new TxError("The transaction was sent but has not confirmed yet.", "reverted", HASH);
    vi.mocked(sendLaunchCampaignClaim).mockRejectedValueOnce(ambiguous);
    await expect(m.claimLaunchCampaign(USER)).rejects.toBe(ambiguous);
    expect(sendLaunchCampaignClaim).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(clearSession).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(ambiguous).toMatchObject({ hash: HASH });
  });
});
