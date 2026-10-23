import { Hono, type Context } from "hono";
import { walletLinkService, WalletLinkError } from "../services/walletLink";
import { getAuthAddress, isSameAddress } from "../middleware/requireWalletAuth";

const walletLinkRoutes = new Hono();

function getRequestIp(c: Context) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const firstForwarded = forwarded.split(",")[0]?.trim();
    if (firstForwarded) {
      return firstForwarded;
    }
  }
  return (
    c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || "unknown"
  );
}

function handleError(c: Context, error: unknown) {
  if (error instanceof WalletLinkError) {
    return c.json({ success: false, error: error.message }, error.status as any);
  }
  console.error("[wallet-link] unexpected error", error);
  return c.json({ success: false, error: "Wallet linking request failed." }, 500);
}

walletLinkRoutes.post("/create-link-request", async (c) => {
  try {
    const body = await c.req.json();
    const result = await walletLinkService.createLinkRequest(body, getRequestIp(c));
    return c.json(result);
  } catch (error) {
    return handleError(c, error);
  }
});

walletLinkRoutes.get("/get-link-request", async (c) => {
  try {
    const token = c.req.query("token") || "";
    const result = await walletLinkService.getLinkRequest(token, getRequestIp(c));
    return c.json(result);
  } catch (error) {
    return handleError(c, error);
  }
});

walletLinkRoutes.post("/confirm-link", async (c) => {
  try {
    const body = await c.req.json();
    const result = await walletLinkService.confirmLink(body, getRequestIp(c));
    return c.json(result);
  } catch (error) {
    return handleError(c, error);
  }
});

walletLinkRoutes.post("/unlink", async (c) => {
  try {
    const body = await c.req.json();
    const result = await walletLinkService.unlinkWallet(body, getRequestIp(c));
    return c.json(result);
  } catch (error) {
    return handleError(c, error);
  }
});

walletLinkRoutes.get("/wallets", async (c) => {
  try {
    const address = c.req.query("address") || "";
    if (!address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    // Linked-wallet relationships deanonymize a person across wallets: require a
    // verified session, and only ever return the caller's own account wallets.
    const authAddress = getAuthAddress(c);
    if (!authAddress) {
      return c.json({ success: false, error: "Authentication required." }, 401);
    }

    const own = await walletLinkService.listWallets(authAddress);
    const ownsTarget =
      isSameAddress(authAddress, address) ||
      own.wallets.some((wallet) => isSameAddress(wallet.wallet_address, address));
    if (!ownsTarget) {
      return c.json({ success: false, error: "Forbidden." }, 403);
    }

    return c.json(own);
  } catch (error) {
    return handleError(c, error);
  }
});

export { walletLinkRoutes };
