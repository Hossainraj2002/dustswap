import { concat, type Hex } from "viem";
import { Attribution } from "ox/erc8021";

/** The same registered code used by DustSwap (apps/web/src/lib/builderCode.ts). */
export const DUSTSWAP_BUILDER_CODE = "bc_tpolfjho";
export const BUILDER_CODE =
  process.env.NEXT_PUBLIC_BUILDER_CODE ||
  process.env.NEXT_PUBLIC_BASE_BUILDER_CODE ||
  DUSTSWAP_BUILDER_CODE;

// A copied deploy variable must not silently attribute MemeFun to another builder.
if (BUILDER_CODE !== DUSTSWAP_BUILDER_CODE) {
  throw new Error(`MemeFun must use DustSwap's builder code ${DUSTSWAP_BUILDER_CODE}. Check the public builder-code configuration.`);
}

export const DATA_SUFFIX: Hex = Attribution.toDataSuffix({
  codes: [BUILDER_CODE],
});

/** Batches must require attribution; unsupported wallets must not drop it. */
export const BUILDER_ATTRIBUTION = { value: DATA_SUFFIX, required: true } as const;

export function appendBuilderCodeToData(data: Hex = "0x"): Hex {
  if (!/^0x(?:[\da-f]{2})*$/i.test(data)) throw new Error("Transaction calldata must contain complete hexadecimal bytes.");

  const normalizedData = data.toLowerCase();
  const normalizedSuffix = DATA_SUFFIX.toLowerCase();

  if (normalizedData.endsWith(normalizedSuffix.slice(2))) {
    return data;
  }

  return concat([data, DATA_SUFFIX]);
}
