/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS, type LaunchSettings } from "@/core/settings";
import { AdminScreen } from "./AdminScreen";

const market = vi.hoisted(() => ({
  kind: "live",
  listCoins: () => [],
  updateSettings: vi.fn(async () => undefined),
  setAdminToken: vi.fn(),
}));
const view = vi.hoisted(() => ({ settings: null as LaunchSettings | null }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market }), useLiveMarket: () => market }));
vi.mock("@/lib/market/hooks", () => ({
  useLaunchSettings: () => view.settings,
  useCoins: () => ({ coins: [] }),
  useModeration: () => ({ banner: "", hidden: [], featured: [] }),
}));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: false, scenario: "default" }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: "0x0000000000000000000000000000000000000001" }) }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/ui/Sheet", () => ({
  Sheet: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  view.settings = DEFAULT_SETTINGS;
  window.sessionStorage.setItem("memefun-admin-token", "test-admin-token");
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe("admin settings validation", () => {
  it.each([
    ["Creation fee", "not-a-number", "0.001"],
    ["Creation fee", "1e309", "0.001"],
    ["Creation fee", "", "0.001"],
    ["Opening market cap", "not-a-number", "6000"],
    ["Opening market cap", "", "6000"],
  ])("keeps %s editable after invalid input %j without constructing a transaction", (label, invalid, valid) => {
    render(<AdminScreen />);
    const input = screen.getByRole("textbox", { name: new RegExp(`^${label}`) }) as HTMLInputElement;
    expect(() => fireEvent.change(input, { target: { value: invalid } })).not.toThrow();
    expect(input.value).toBe(invalid);
    expect(screen.getByRole("button", { name: "Review" }).matches(":disabled")).toBe(true);
    expect(market.updateSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: valid } });
    expect(screen.getByRole("button", { name: "Review" }).matches(":disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign as owner" }).matches(":disabled")).toBe(false);
  });

  it("blocks signing when an open review becomes invalid and permits a corrected owner change", async () => {
    render(<AdminScreen />);
    const input = screen.getByRole("textbox", { name: /^Creation fee/ });
    fireEvent.change(input, { target: { value: "0.001" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("setCreationFee(1000000000000000)")).toBeDefined();
    fireEvent.change(input, { target: { value: "" } });
    const sign = screen.getByRole("button", { name: "Sign as owner" });
    expect(sign.matches(":disabled")).toBe(true);
    fireEvent.click(sign);
    expect(market.updateSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "0.002" } });
    fireEvent.click(sign);
    await waitFor(() => expect(market.updateSettings).toHaveBeenCalledOnce());
    expect(market.updateSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, creationFeeEth: 0.002 });
    expect(market.setAdminToken).toHaveBeenCalledWith("test-admin-token");
  });

  it("still requires the admin token before exposing owner settings", () => {
    window.sessionStorage.clear();
    render(<AdminScreen />);
    expect(screen.getByRole("heading", { name: "Admin access" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: /^Creation fee/ })).toBeNull();
    expect(market.setAdminToken).not.toHaveBeenCalled();
    expect(market.updateSettings).not.toHaveBeenCalled();
  });

  it("adopts asynchronously loaded settings before the admin edits", () => {
    view.settings = null;
    const { rerender } = render(<AdminScreen />);
    view.settings = { ...DEFAULT_SETTINGS, creationFeeEth: 0.004, openingFdvUsd: 6000 };
    rerender(<AdminScreen />);
    expect((screen.getByRole("textbox", { name: /^Creation fee/ }) as HTMLInputElement).value).toBe("0.004");
    expect((screen.getByRole("textbox", { name: /^Opening market cap/ }) as HTMLInputElement).value).toBe("6000");
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("preserves unsaved edits across a refresh and follows settings again after discard", () => {
    const { rerender } = render(<AdminScreen />);
    const input = screen.getByRole("textbox", { name: /^Creation fee/ }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0.001" } });
    view.settings = { ...DEFAULT_SETTINGS, creationFeeEth: 0.004 };
    rerender(<AdminScreen />);
    expect(input.value).toBe("0.001");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(input.value).toBe("0.004");
    view.settings = { ...view.settings, creationFeeEth: 0.006 };
    rerender(<AdminScreen />);
    expect(input.value).toBe("0.006");
    expect(market.updateSettings).not.toHaveBeenCalled();
  });
});
