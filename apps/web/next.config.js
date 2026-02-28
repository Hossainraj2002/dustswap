/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      { protocol: 'https', hostname: 'token-icons.s3.amazonaws.com' },
      { protocol: 'https', hostname: 'logos.covalenthq.com' },
    ],
  },
};

module.exports = nextConfig;
