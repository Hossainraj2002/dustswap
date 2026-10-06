import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { ownerCalls } from "./ownerCalls";

describe("ownerCalls", () => {
  it("emits nothing when nothing changed", () => {
    expect(ownerCalls(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toEqual([]);
  });

  it("maps each change to one owner call with exact arguments", () => {
    const calls = ownerCalls(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      platformShareBps: 2500,
      creationFeeEth: 0.001,
      openingFdvUsd: 6000,
      launchesPaused: true,
      enabledModes: ["creator", "burn"],
      enabledQuoteKinds: ["native", "stable"],
    });
    expect(calls.map((call) => call.fn)).toEqual([
      "setCreationFee",
      "setPlatformShareBps",
      "setOpeningFdvUsd",
      "setLaunchesPaused",
      "setModeEnabled",
      "setModeEnabled",
      "setQuoteKindEnabled",
      "setQuoteKindEnabled",
    ]);
    expect(calls[0]?.args).toEqual(["1000000000000000"]);
    expect(calls[1]?.args).toEqual(["2500"]);
    expect(calls[2]?.args).toEqual(["600000000000"]);
    expect(calls[4]?.args).toEqual(["2", "false"]);
    expect(calls[6]?.args).toEqual(["2", "false"]);
    expect(calls[7]?.args).toEqual(["3", "false"]);
  });

  it("never uses arrows or em-dashes in summaries", () => {
    const calls = ownerCalls(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, platformShareBps: 3000, snipeStartBps: 9000 });
    for (const call of calls) expect(call.summary).not.toMatch(/[→—…]/);
  });
});
