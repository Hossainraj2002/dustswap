import sharp from "sharp";

// Bound libvips' retained operation cache for a low-traffic service. This does not cap the
// working memory needed to decode an image, and leaves Sharp's platform-aware concurrency intact.
sharp.cache({ memory: 8, files: 0, items: 32 });

export default sharp;
