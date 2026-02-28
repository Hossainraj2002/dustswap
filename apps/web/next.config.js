const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@react-native-async-storage/async-storage': path.resolve(
        __dirname,
        './src/shims/async-storage.ts'
      ),
    };
    return config;
  },
};

module.exports = nextConfig;