/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoinAvatar } from "./CoinAvatar";

vi.mock("@/lib/live/config", () => ({ API_URL: "https://memefun-api.dustswap.wtf" }));
afterEach(cleanup);

describe("coin media rendering", () => {
  it("loads immutable legacy images through the CDN while retaining lazy loading", () => {
    const path = "/media/bafkreigz6vox5dempm45jvowv43et2gpu25ml3lss6lx6ytct6nhzgrmna";
    render(<CoinAvatar src={`https://memefun-api-production.up.railway.app${path}`} alt="MemeFun" size={40} />);
    const image = screen.getByRole("img", { name: "MemeFun" });
    expect(image.getAttribute("src")).toBe(`https://memefun-api.dustswap.wtf${path}`);
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  it("retries changed image metadata after an earlier source fails", () => {
    const { rerender } = render(<CoinAvatar src="https://images.example/old.png" alt="Coin" symbol="COIN" size={40} />);
    fireEvent.error(screen.getByRole("img", { name: "Coin" }));
    expect(screen.getByRole("img", { name: "Coin" }).tagName).toBe("SPAN");
    rerender(<CoinAvatar src="https://images.example/new.png" alt="Coin" symbol="COIN" size={40} />);
    expect(screen.getByRole("img", { name: "Coin" }).getAttribute("src")).toBe("https://images.example/new.png");
  });
});
