import sharp from "sharp";

import { envInt, optionalEnv } from "../env";

// Bound libvips' retained operation cache for a low-traffic service. This does not cap the
// working memory needed to decode an image. Concurrency stays platform-aware unless explicitly
// configured; Linux allocator tuning should set this to 1 so image bursts retain that bound.
sharp.cache({ memory: 8, files: 0, items: 32 });
if (optionalEnv("MEMEFUN_SHARP_CONCURRENCY") !== undefined) {
  sharp.concurrency(envInt("MEMEFUN_SHARP_CONCURRENCY", 1, { min: 1, max: 8 }));
}

export default sharp;
