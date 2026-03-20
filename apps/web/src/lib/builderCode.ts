// @ts-ignore - ox exports may not resolve correctly in Next.js bundler types
import { Attribution } from "ox/erc8021";

export const BUILDER_CODE =
  process.env.NEXT_PUBLIC_BUILDER_CODE || "bc_ox7237gv";

export const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [BUILDER_CODE],
});
