import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";

import { expectedFiles, orphanedFiles, sourcesAvailable } from "../../scripts/sync-shared";

/**
 * The backend computes with copies of the app's core math, data types and contract ABIs. This
 * fails as soon as a copy is stale, so the UI and the backend can never quietly disagree. (Skipped
 * where the app sources are not part of the checkout, e.g. a service-only build.)
 */
describe.skipIf(!sourcesAvailable())("shared code", () => {
  it("every synced copy matches its source", () => {
    const stale: string[] = [];
    const expected = expectedFiles();
    for (const [path, contents] of expected) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== contents) stale.push(relative(process.cwd(), path));
    }
    stale.push(...orphanedFiles(expected).map((path) => `${relative(process.cwd(), path)} (orphaned)`));
    expect(stale, "run `pnpm sync-shared`").toEqual([]);
  });
});
