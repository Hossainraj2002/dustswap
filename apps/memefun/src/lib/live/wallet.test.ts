import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWalletClient, custom } from "viem";
import { baseSepolia } from "viem/chains";
import { rememberWalletAccount } from "@/lib/wallet/walletAccount";
import { connectedWallet } from "./wallet";

const actions = vi.hoisted(() => ({ getConnection: vi.fn(), switchChain: vi.fn(), getWalletClient: vi.fn() }));
vi.mock("wagmi/actions", () => actions);
vi.mock("@/lib/wallet/wagmi", () => ({ wagmiConfig: {} }));
vi.mock("@/lib/chain", () => ({ CHAIN_NAME: "Base Sepolia", TARGET_CHAIN_ID: 84532 }));
const ADDRESS = "0x00000000000000000000000000000000000000aa" as const;
const external = { uid: "external", id: "selected-external" };
const smart = { uid: "smart", id: "selected-smart" };
const wallet = createWalletClient({ account: ADDRESS, chain: baseSepolia, transport: custom({ request: vi.fn() }) });
let selection: { address: typeof ADDRESS; connector: typeof external; chainId: number; status: string };

beforeEach(() => {
  vi.resetAllMocks();
  selection = { address: ADDRESS, connector: external, chainId: baseSepolia.id, status: "connected" };
  actions.getConnection.mockImplementation(() => selection);
  actions.getWalletClient.mockResolvedValue(wallet);
});

describe("selected wallet transaction context", () => {
  it("binds the client to the captured connector and preserves known smart-account attribution", async () => {
    rememberWalletAccount(smart, { address: ADDRESS, walletClientType: "base_account" });
    selection = { ...selection, connector: smart };
    const client = await connectedWallet(ADDRESS);
    expect(actions.getWalletClient).toHaveBeenCalledWith({}, { connector: smart, account: ADDRESS, chainId: baseSepolia.id });
    expect(client.requiresWalletAttribution).toBe(true);
  });

  it("binds a chain switch to the chosen provider", async () => {
    selection = { ...selection, chainId: 1 };
    actions.switchChain.mockImplementation(async () => { selection = { ...selection, chainId: baseSepolia.id }; });
    const client = await connectedWallet(ADDRESS);
    expect(actions.switchChain).toHaveBeenCalledWith({}, { chainId: baseSepolia.id, connector: external });
    expect(client.requiresWalletAttribution).toBe(false);
  });

  it("refuses a same-address provider change while switching networks", async () => {
    selection = { ...selection, chainId: 1 };
    actions.switchChain.mockImplementation(async () => { selection = { ...selection, connector: smart }; });
    await expect(connectedWallet(ADDRESS)).rejects.toThrow("selected wallet changed");
    expect(actions.getWalletClient).not.toHaveBeenCalled();
  });

  it("refuses a same-address provider change while obtaining the client", async () => {
    actions.getWalletClient.mockImplementation(async () => { selection = { ...selection, connector: smart }; return wallet; });
    await expect(connectedWallet(ADDRESS)).rejects.toThrow("selected wallet changed");
  });
});
