import path from 'node:path';
import pkg from './package.json' with { type: 'json' };

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['./data/chatgpt-private/**', './data/chatgpt-analysis-verification.json'],
  },
  images: {
    remotePatterns: [
      {
        hostname: 's2.googleusercontent.com',
      },
    ],
  },
  serverExternalPackages: [
    'playwright',
  ],
  outputFileTracingIncludes: {
    '/api/**': [
      './skills/**',
    ],
  },
  env: {
    NEXT_PUBLIC_VERSION: pkg.version,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
