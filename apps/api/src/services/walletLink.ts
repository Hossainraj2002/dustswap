import { createHash, randomBytes } from "crypto";
import { getAddress, isAddress } from "viem";
import { postgresDb } from "./postgres";
import { pointsEngine } from "./pointsEngine";
import { isAllowedAppDomain, getAllowedAppOrigins } from "../config/appOrigins";
import { createBasePublicClient } from "../utils/baseRpc";
import { runtimeCache } from "../utils/runtimeCache";

const WALLET_LINK_STATEMENT = "DustSwap Wallet Linking";
const SIGNATURE_TTL_MS = 5 * 60 * 1000;
const SIGNATURE_FUTURE_SKEW_MS = 60 * 1000;
const ACTION_WINDOW_MS = 60 * 1000;
const CREATE_LIMIT = 3;
const CONFIRM_LIMIT = 6;
const UNLINK_LIMIT = 6;
const GET_REQUEST_IP_WINDOW_MS = 60 * 1000;
const GET_REQUEST_IP_LIMIT = 60;

const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_WALLETS_PER_ACCOUNT = 2;

const publicClient = createBasePublicClient();

export type WalletLinkAction =
  | "create-link-request"
  | "confirm-link"
  | "unlink-wallet";

export class WalletLinkError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WalletLinkError";
    this.status = status;
  }
}

type SignedInput = {
  address?: string;
  message?: string;
  signature?: `0x${string}`;
};

type ParsedMessage = {
  address: string;
  action: string;
  timestamp: string;
  nonce: string;
  domain: string;
  token: string;
  wallet: string;
};

export function isWalletLinkingEnabled() {
  const raw = String(process.env.WALLET_LINKING_ENABLED || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function getLinkBonusPp() {
  const parsed = Number.parseInt(process.env.WALLET_LINK_BONUS_PP || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000;
}

// Authoritative confirm-link payment params, surfaced to the client so the tx it
// builds always matches what the backend verifies (avoids env drift).
function getLinkPaymentRecipient() {
  return (
    process.env.WALLET_LINK_RECIPIENT ||
    process.env.NEXT_PUBLIC_WALLET_LINK_RECIPIENT ||
    "0x72Bd4b89fFb1e1f48253b7a7a65739ff1E696442"
  );
}

function getLinkPaymentEth() {
  return (
    process.env.WALLET_LINK_PAYMENT_ETH ||
    process.env.NEXT_PUBLIC_WALLET_LINK_PAYMENT_ETH ||
    "0.00001"
  );
}

function normalizeStored(address: string) {
  return address.trim().toLowerCase();
}

function toChecksum(address: string) {
  return getAddress(address);
}

function genReferralCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return (
    "DUST-" +
    Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function getAppOrigin() {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.WEB_URL ||
    process.env.FRONTEND_URL;
  if (configured) {
    try {
      return new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`).origin;
    } catch {
      // fall through to defaults
    }
  }
  const origins = getAllowedAppOrigins();
  const preferred = origins.find((origin) => !origin.includes("localhost"));
  return preferred || origins[0] || "https://dustswap.wtf";
}

function shortAddress(address: string) {
  const checksum = (() => {
    try {
      return toChecksum(address);
    } catch {
      return address;
    }
  })();
  return `${checksum.slice(0, 6)}…${checksum.slice(-4)}`;
}

function parseWalletLinkMessage(message: string): ParsedMessage {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== WALLET_LINK_STATEMENT) {
    throw new WalletLinkError("Invalid wallet linking message.", 401);
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    fields.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim()
    );
  }

  return {
    address: fields.get("address") || "",
    action: fields.get("action") || "",
    timestamp: fields.get("timestamp") || "",
    nonce: fields.get("nonce") || "",
    domain: fields.get("domain") || "",
    token: fields.get("token") || "",
    wallet: fields.get("wallet") || "",
  };
}

class WalletLinkService {
  private async assertAuthenticatedAction(
    input: SignedInput,
    expectedAction: WalletLinkAction,
    requestIp: string,
    limit: number
  ): Promise<ParsedMessage & { address: string }> {
    if (!input.address || !input.message || !input.signature) {
      throw new WalletLinkError("address, message, and signature are required", 400);
    }
    if (!isAddress(input.address)) {
      throw new WalletLinkError("Invalid wallet address.", 400);
    }

    const normalizedAddress = normalizeStored(input.address);
    const parsed = parseWalletLinkMessage(input.message);

    if (normalizeStored(parsed.address) !== normalizedAddress) {
      throw new WalletLinkError("Wallet linking signature address mismatch.", 401);
    }
    if (parsed.action !== expectedAction) {
      throw new WalletLinkError("Invalid wallet linking action.", 401);
    }
    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new WalletLinkError("Unexpected wallet linking domain.", 401);
    }
    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new WalletLinkError("Invalid wallet linking nonce.", 401);
    }

    const timestampMs = Date.parse(parsed.timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      throw new WalletLinkError("Invalid wallet linking timestamp.", 401);
    }
    if (now - timestampMs > SIGNATURE_TTL_MS) {
      throw new WalletLinkError("Expired wallet linking signature.", 401);
    }
    if (timestampMs - now > SIGNATURE_FUTURE_SKEW_MS) {
      throw new WalletLinkError("Invalid wallet linking timestamp.", 401);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `wallet-link:${expectedAction}:rate:${normalizedAddress}:${requestIp}`,
      limit,
      ACTION_WINDOW_MS
    );
    if (!rateLimit.allowed) {
      throw new WalletLinkError("Wallet linking is cooling down. Please wait.", 429);
    }

    const replayKey = `wallet-link:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;
    if (runtimeCache.get(replayKey)) {
      throw new WalletLinkError("Wallet linking signature was already used.", 401);
    }

    const valid = await publicClient.verifyMessage({
      address: toChecksum(normalizedAddress) as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });
    if (!valid) {
      throw new WalletLinkError("Invalid wallet linking signature.", 401);
    }

    runtimeCache.set(replayKey, true, SIGNATURE_TTL_MS);

    return { ...parsed, address: normalizedAddress };
  }

  // head+count returns the row count via the response `count` field.
  private async countWalletsFallback(userId: number): Promise<number> {
    const res: any = await postgresDb
      .from("user_wallets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (res?.error) {
      throw new WalletLinkError(`Count wallets: ${res.error.message}`, 500);
    }
    return Number(res?.count || 0);
  }

  private async loadWalletRow(walletAddress: string) {
    const { data, error } = await postgresDb
      .from("user_wallets")
      .select("user_id, wallet_address, is_primary")
      .eq("wallet_address", normalizeStored(walletAddress))
      .maybeSingle();
    if (error) {
      throw new WalletLinkError(`Load wallet: ${error.message}`, 500);
    }
    return (data as { user_id: number; wallet_address: string; is_primary: boolean } | null) ?? null;
  }

  async createLinkRequest(input: SignedInput, requestIp: string) {
    if (!isWalletLinkingEnabled()) {
      throw new WalletLinkError("Wallet linking is currently disabled.", 503);
    }

    const auth = await this.assertAuthenticatedAction(
      input,
      "create-link-request",
      requestIp,
      CREATE_LIMIT
    );

    const source = await pointsEngine.getOrCreate(auth.address);
    const sourceWalletCount = await this.countWalletsFallback(source.id);
    if (sourceWalletCount >= MAX_WALLETS_PER_ACCOUNT) {
      throw new WalletLinkError(
        "This account already has the maximum number of linked wallets.",
        409
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();

    // Expire this account's older pending requests so only one is live at a time.
    await postgresDb
      .from("wallet_link_requests")
      .update({ status: "cancelled" })
      .eq("source_user_id", source.id)
      .eq("status", "pending");

    const { error } = await postgresDb.from("wallet_link_requests").insert({
      token_hash: hashToken(token),
      source_user_id: source.id,
      source_wallet: normalizeStored(auth.address),
      status: "pending",
      expires_at: expiresAt,
    });
    if (error) {
      throw new WalletLinkError(`Create link request: ${error.message}`, 500);
    }

    return {
      success: true as const,
      token,
      url: `${getAppOrigin()}/link?token=${token}`,
      expiresAt,
      bonusPp: getLinkBonusPp(),
    };
  }

  private async loadPendingRequestByToken(token: string) {
    if (!token || token.length < 16 || token.length > 256) {
      throw new WalletLinkError("Invalid link token.", 400);
    }
    const { data, error } = await postgresDb
      .from("wallet_link_requests")
      .select("id, source_user_id, source_wallet, status, expires_at")
      .eq("token_hash", hashToken(token))
      .maybeSingle();
    if (error) {
      throw new WalletLinkError(`Load link request: ${error.message}`, 500);
    }
    const row = data as
      | {
          id: number;
          source_user_id: number;
          source_wallet: string;
          status: string;
          expires_at: string;
        }
      | null;
    if (!row || row.status !== "pending") {
      throw new WalletLinkError("This link is invalid or has already been used.", 410);
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await postgresDb
        .from("wallet_link_requests")
        .update({ status: "expired" })
        .eq("id", row.id);
      throw new WalletLinkError("This link has expired. Please generate a new one.", 410);
    }
    return row;
  }

  async getLinkRequest(token: string, requestIp: string) {
    if (!isWalletLinkingEnabled()) {
      throw new WalletLinkError("Wallet linking is currently disabled.", 503);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `wallet-link:get:rate:${requestIp}`,
      GET_REQUEST_IP_LIMIT,
      GET_REQUEST_IP_WINDOW_MS
    );
    if (!rateLimit.allowed) {
      throw new WalletLinkError("Too many requests. Please wait a moment.", 429);
    }

    const row = await this.loadPendingRequestByToken(token);

    const { data: userData } = await postgresDb
      .from("users")
      .select("address, total_points, current_streak")
      .eq("id", row.source_user_id)
      .maybeSingle();
    const { data: profileData } = await postgresDb
      .from("user_profiles")
      .select("display_name, username, pfp_url")
      .eq("user_id", row.source_user_id)
      .maybeSingle();

    const user = userData as
      | { address: string; total_points: number; current_streak: number }
      | null;
    const profile = profileData as
      | { display_name: string | null; username: string | null; pfp_url: string | null }
      | null;

    return {
      success: true as const,
      preview: {
        shortAddress: shortAddress(row.source_wallet),
        displayName: profile?.display_name || profile?.username || null,
        username: profile?.username || null,
        pfpUrl: profile?.pfp_url || null,
        totalPoints: Number(user?.total_points || 0),
        currentStreak: Number(user?.current_streak || 0),
      },
      bonusPp: getLinkBonusPp(),
      paymentTo: getLinkPaymentRecipient(),
      paymentEth: getLinkPaymentEth(),
      expiresAt: row.expires_at,
    };
  }

  async confirmLink(
    input: { token?: string; address?: string; txHash?: string },
    requestIp: string
  ) {
    if (!isWalletLinkingEnabled()) {
      throw new WalletLinkError("Wallet linking is currently disabled.", 503);
    }

    const token = input.token || "";
    const address = input.address || "";
    const txHash = input.txHash || "";

    if (!token || !isAddress(address)) {
      throw new WalletLinkError("token and address are required.", 400);
    }
    // txHash is optional: on the resume path (Base App reloaded the frame after
    // the payment) the client may have lost it, and the backend discovers it.
    if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new WalletLinkError("Invalid payment transaction hash.", 400);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `wallet-link:confirm:rate:${address.toLowerCase()}:${requestIp}`,
      CONFIRM_LIMIT,
      ACTION_WINDOW_MS
    );
    if (!rateLimit.allowed) {
      throw new WalletLinkError("Wallet linking is cooling down. Please wait.", 429);
    }

    const request = await this.loadPendingRequestByToken(token);
    const targetWallet = normalizeStored(address);

    if (targetWallet === normalizeStored(request.source_wallet)) {
      throw new WalletLinkError("You can't link a wallet to itself.", 400);
    }

    // Resolve/auto-create the target account.
    const target = await pointsEngine.getOrCreate(address);

    // Already linked to the source account → idempotent success.
    if (target.id === request.source_user_id) {
      await postgresDb
        .from("wallet_link_requests")
        .update({ status: "consumed", consumed_at: new Date().toISOString() })
        .eq("id", request.id);
      return {
        success: true as const,
        alreadyLinked: true,
        primaryAddress: request.source_wallet,
        linkedWallet: targetWallet,
        awardedPp: 0,
      };
    }

    // The target wallet must not already be a linked (secondary) wallet of any
    // account, and its account must be single-wallet (we don't merge multi-wallet
    // accounts through this flow).
    const targetWalletRow = await this.loadWalletRow(targetWallet);
    if (targetWalletRow && targetWalletRow.is_primary === false) {
      throw new WalletLinkError("This wallet is already linked to another account.", 409);
    }
    const targetWalletCount = await this.countWalletsFallback(target.id);
    if (targetWalletCount > 1) {
      throw new WalletLinkError(
        "This wallet's account already has linked wallets and can't be merged here.",
        409
      );
    }

    const primaryWalletCount = await this.countWalletsFallback(request.source_user_id);
    if (primaryWalletCount >= MAX_WALLETS_PER_ACCOUNT) {
      throw new WalletLinkError(
        "The destination account already has the maximum number of linked wallets.",
        409
      );
    }

    // Confirmation is a real on-chain payment from the Base Account, bound to
    // THIS link by embedding the token hash in the tx calldata (so an unrelated
    // payment can't be replayed to hijack a wallet).
    const tokenHash = hashToken(token);
    let resolvedTxHash = txHash;
    if (!resolvedTxHash) {
      // Resume path: discover the payment on-chain from { token, address }.
      const found = await pointsEngine.findWalletLinkPaymentTx(targetWallet, tokenHash);
      if (!found) {
        throw new WalletLinkError(
          "We couldn't find your link payment yet. Please wait a moment and try again.",
          404
        );
      }
      resolvedTxHash = found;
    }

    try {
      await pointsEngine.verifyWalletLinkPayment(targetWallet, resolvedTxHash, tokenHash);
    } catch (err) {
      throw new WalletLinkError(
        err instanceof Error ? err.message : "Could not verify the link payment.",
        400
      );
    }

    const { data: mergeId, error } = await postgresDb.rpc("merge_accounts", {
      p_primary_user_id: request.source_user_id,
      p_secondary_user_id: target.id,
      p_secondary_wallet: targetWallet,
      p_link_request_id: request.id,
      p_bonus_pp: getLinkBonusPp(),
    });
    if (error) {
      throw new WalletLinkError(`Link wallets: ${error.message}`, 500);
    }

    // Read the awarded bonus + new total back for the response.
    const { data: mergeRow } = await postgresDb
      .from("account_merges")
      .select("link_bonus_awarded, link_bonus_pp")
      .eq("id", Number(mergeId))
      .maybeSingle();
    const { data: primaryUser } = await postgresDb
      .from("users")
      .select("address, total_points")
      .eq("id", request.source_user_id)
      .maybeSingle();

    pointsEngine.invalidateUserReadCaches(request.source_wallet);
    pointsEngine.invalidateUserReadCaches(targetWallet);

    const merge = mergeRow as { link_bonus_awarded: boolean; link_bonus_pp: number } | null;
    const primary = primaryUser as { address: string; total_points: number } | null;

    return {
      success: true as const,
      alreadyLinked: false,
      mergeId: Number(mergeId),
      primaryAddress: primary?.address || request.source_wallet,
      linkedWallet: targetWallet,
      awardedPp: merge?.link_bonus_awarded ? Number(merge.link_bonus_pp || 0) : 0,
      newTotalPp: Number(primary?.total_points || 0),
    };
  }

  async unlinkWallet(
    input: SignedInput & { walletToUnlink?: string },
    requestIp: string
  ) {
    if (!isWalletLinkingEnabled()) {
      throw new WalletLinkError("Wallet linking is currently disabled.", 503);
    }

    const auth = await this.assertAuthenticatedAction(
      input,
      "unlink-wallet",
      requestIp,
      UNLINK_LIMIT
    );

    // The wallet performing the unlink (and signing) is the one being detached.
    const walletToUnlink = normalizeStored(input.walletToUnlink || auth.address);
    if (walletToUnlink !== normalizeStored(auth.address)) {
      throw new WalletLinkError("You can only unlink the wallet you signed with.", 401);
    }
    // The signed message binds the wallet field too.
    if (auth.wallet && normalizeStored(auth.wallet) !== walletToUnlink) {
      throw new WalletLinkError("Wallet linking signature is not bound to this wallet.", 401);
    }

    const walletRow = await this.loadWalletRow(walletToUnlink);
    if (!walletRow) {
      throw new WalletLinkError("This wallet is not linked to any account.", 404);
    }
    if (walletRow.is_primary) {
      throw new WalletLinkError("You can't unlink your primary wallet.", 400);
    }

    const { data: newUserId, error } = await postgresDb.rpc("unlink_wallet", {
      p_user_id: walletRow.user_id,
      p_wallet: walletToUnlink,
      p_new_referral_code: genReferralCode(),
    });
    if (error) {
      throw new WalletLinkError(`Unlink wallet: ${error.message}`, 500);
    }

    pointsEngine.invalidateUserReadCaches(walletToUnlink);

    return {
      success: true as const,
      detachedWallet: walletToUnlink,
      newUserId: Number(newUserId),
    };
  }

  async listWallets(address: string) {
    if (!isAddress(address)) {
      throw new WalletLinkError("Invalid wallet address.", 400);
    }
    const account = await pointsEngine.getOrCreate(address);
    const { data, error } = await postgresDb
      .from("user_wallets")
      .select("wallet_address, wallet_type, is_primary, linked_at")
      .eq("user_id", account.id)
      .order("is_primary", { ascending: false });
    if (error) {
      throw new WalletLinkError(`List wallets: ${error.message}`, 500);
    }
    const wallets = (data as Array<{
      wallet_address: string;
      wallet_type: string;
      is_primary: boolean;
      linked_at: string;
    }>) || [];
    return {
      success: true as const,
      primaryAddress: account.address,
      wallets,
    };
  }
}

export const walletLinkService = new WalletLinkService();
