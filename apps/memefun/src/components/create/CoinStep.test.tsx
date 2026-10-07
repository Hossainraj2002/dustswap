/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_DRAFT, type CreateDraft } from "@/lib/create/draft";
import { CoinStep } from "./CoinStep";

const view = vi.hoisted(() => ({ normalize: vi.fn() }));
vi.mock("@/lib/create/image", () => ({ normalizeCoinImage: (...args: unknown[]) => view.normalize(...args) }));
vi.mock("@/lib/market/hooks", () => ({ useCoins: () => ({ coins: [] }) }));
beforeEach(() => view.normalize.mockReset());
afterEach(cleanup);
function Editor() {
  const [draft, setDraft] = useState<CreateDraft>({ ...EMPTY_DRAFT, image: "original-image" });
  return <CoinStep draft={draft} update={patch => setDraft(current => ({ ...current, ...patch }))} errors={{}} showErrors={false} />;
}
const file = (name: string) => new File(["image"], name, { type: "image/png" });
function pendingImage() {
  let resolve!: (image: string) => void;
  const promise = new Promise<string>(done => { resolve = done; });
  return { promise, resolve };
}

describe("coin image selection", () => {
  it("keeps the latest selection when image conversion finishes out of order", async () => {
    const first = pendingImage(); const second = pendingImage();
    view.normalize.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const page = render(<Editor />);
    const input = page.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file("first.png")] } });
    fireEvent.change(input, { target: { files: [file("second.png")] } });
    await act(async () => second.resolve("second-image"));
    expect(page.container.querySelector("img")?.getAttribute("src")).toBe("second-image");
    await act(async () => first.resolve("first-image"));
    expect(page.container.querySelector("img")?.getAttribute("src")).toBe("second-image");
  });
  it("does not restore an image removed while conversion was pending", async () => {
    const pending = pendingImage(); view.normalize.mockReturnValueOnce(pending.promise);
    const page = render(<Editor />);
    fireEvent.change(page.container.querySelector('input[type="file"]')!, { target: { files: [file("new.png")] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await act(async () => pending.resolve("removed-image"));
    expect(page.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose an image" })).toBeDefined();
  });
  it("does not mutate a draft after leaving the image step", async () => {
    const pending = pendingImage(); view.normalize.mockReturnValueOnce(pending.promise);
    const update = vi.fn();
    const page = render(<CoinStep draft={EMPTY_DRAFT} update={update} errors={{}} showErrors={false} />);
    fireEvent.change(page.container.querySelector('input[type="file"]')!, { target: { files: [file("new.png")] } });
    page.unmount();
    await act(async () => pending.resolve("late-image"));
    expect(update).not.toHaveBeenCalled();
  });
});
