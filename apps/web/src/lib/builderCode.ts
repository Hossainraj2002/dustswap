import { concat, type Hex } from "viem";
// @ts-ignore - ox exports may not resolve correctly in Next.js bundler types
import { Attribution } from "ox/erc8021";

export const BUILDER_CODE =
  process.env.NEXT_PUBLIC_BUILDER_CODE || "bc_ox7237gv";

export const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [BUILDER_CODE],
});

export function appendBuilderCodeToData(data?: Hex) {
  if (!data) {
    return data;
  }

  const normalizedData = data.toLowerCase();
  const normalizedSuffix = DATA_SUFFIX.toLowerCase();

  if (normalizedData.endsWith(normalizedSuffix.slice(2))) {
    return data;
  }

  return concat([data, DATA_SUFFIX]);
}
