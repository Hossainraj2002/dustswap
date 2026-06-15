import { Hono, type Context } from "hono";
import { walletLinkService, WalletLinkError } from "../services/walletLink";

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
    const result = await walletLinkService.listWallets(address);
    return c.json(result);
  } catch (error) {
    return handleError(c, error);
  }
});

export { walletLinkRoutes };
