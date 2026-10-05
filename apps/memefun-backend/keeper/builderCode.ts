import { Attribution } from "ox/erc8021";

/** The canonical registered code used by the public DustSwap and MemeFun applications. */
export const BUILDER_CODE = "bc_tpolfjho";
export const DATA_SUFFIX = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

/** Called after loadLocalEnv(), before initializing any keeper signing clients. */
export function keeperAttribution() {
  for (const name of ["MEMEFUN_BUILDER_CODE", "BUILDER_CODE", "BASE_BUILDER_CODE", "NEXT_PUBLIC_BUILDER_CODE", "NEXT_PUBLIC_BASE_BUILDER_CODE"]) {
    const value = process.env[name]?.trim();
    if (value && value !== BUILDER_CODE) throw new Error(`${name} must match DustSwap's builder code ${BUILDER_CODE}.`);
  }
  return { value: DATA_SUFFIX, required: true } as const;
}
