// @ts-ignore - ox exports may not resolve correctly in Next.js bundler types
import { Attribution } from "ox/erc8021";
import { concatHex, type Hex } from "viem";

export const BUILDER_CODE =
  process.env.NEXT_PUBLIC_BUILDER_CODE || "bc_ox7237gv";

export const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [BUILDER_CODE],
});

export function appendBuilderCodeData(data?: string) {
  if (data?.toLowerCase().endsWith(DATA_SUFFIX.slice(2).toLowerCase())) {
    return data as Hex;
  }

  return data
    ? concatHex([data as Hex, DATA_SUFFIX])
    : DATA_SUFFIX;
}
