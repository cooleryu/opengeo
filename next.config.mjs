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
    'pdf-parse',
    'playwright',
    'officeparser',
    'file-type',
  ],
  outputFileTracingIncludes: {
    '/api/**': [
      './skills/answer-evidence-review/**',
      './skills/question-planning/**',
      './skills/competitor-analysis/**',
      './skills/competitor-citation-review/**',
      './skills/improvement-planning/**',
      './node_modules/@napi-rs/canvas/**',
      './node_modules/@napi-rs/canvas-linux-x64-gnu/**',
      './node_modules/@napi-rs/canvas-linux-x64-musl/**',
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
