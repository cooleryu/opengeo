/*
MIT License

Copyright (c) 2022 Umami Software, Inc. <hello@umami.is>
Copyright (c) 2026 Liekan contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

/**
 * Adapted from GEOInflow at 8058869d70e3b6d0fd94f233c7484e7db58fe046 (read 2026-10-27).
 * Data: config/liekan/ai-platform-coverage.json, enabled && kind === 'ai'.
 * Matching: src/lib/liekan/contracts/sources.ts, referralForHost.
 * Runtime dependencies: native URL only. No published catalog, crawler data,
 * database, network requests, events, UTM inference, or background work.
 *
 * A match is a recognized AI-product referrer host, not proof of an AI answer,
 * search, a human visit, causal impact, or crawler activity.
 * Null means absent, malformed, or unrecognized evidence; never zero AI traffic.
 */
export type AiReferralRule = Readonly<{
  id: string;
  host: string;
  includeSubdomains: boolean;
  platformId: string;
  productId: string;
}>;

export const GEOINFLOW_REFERRAL_REVISION =
  '8058869d70e3b6d0fd94f233c7484e7db58fe046';

export const AI_REFERRAL_RULES: readonly AiReferralRule[] = [
  {
    id: 'chatgpt-com',
    host: 'chatgpt.com',
    includeSubdomains: false,
    platformId: 'openai',
    productId: 'chatgpt',
  },
  {
    id: 'chat-openai-com',
    host: 'chat.openai.com',
    includeSubdomains: false,
    platformId: 'openai',
    productId: 'chatgpt',
  },
  {
    id: 'claude-ai',
    host: 'claude.ai',
    includeSubdomains: false,
    platformId: 'anthropic',
    productId: 'claude',
  },
  {
    id: 'perplexity-ai',
    host: 'perplexity.ai',
    includeSubdomains: false,
    platformId: 'perplexity',
    productId: 'perplexity',
  },
  {
    id: 'www-perplexity-ai',
    host: 'www.perplexity.ai',
    includeSubdomains: false,
    platformId: 'perplexity',
    productId: 'perplexity',
  },
  {
    id: 'app-perplexity-ai',
    host: 'app.perplexity.ai',
    includeSubdomains: false,
    platformId: 'perplexity',
    productId: 'perplexity',
  },
  {
    id: 'gemini-google-com',
    host: 'gemini.google.com',
    includeSubdomains: false,
    platformId: 'google',
    productId: 'gemini',
  },
  {
    id: 'copilot-microsoft-com',
    host: 'copilot.microsoft.com',
    includeSubdomains: false,
    platformId: 'microsoft',
    productId: 'copilot',
  },
];

/** Accept a browser HTTP(S) referrer URL or Umami's normalized hostname. */
export function normalizeReferrerHost(
  referrer: string | null | undefined,
): string | null {
  if (!referrer?.trim()) return null;
  const value = referrer.trim();
  // Bare values must be hosts, never paths, aliases, query strings, or credentials.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!absolute && !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(value)) return null;
  try {
    const url = new URL(absolute ? value : `https://${value}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

export function identifyAiReferral(
  referrer: string | null | undefined,
):
  | (AiReferralRule & { observedHost: string; evidence: 'referrer-host' })
  | null {
  const host = normalizeReferrerHost(referrer);
  if (!host) return null;
  const rule = AI_REFERRAL_RULES.find(
    (item) =>
      host === item.host ||
      (item.includeSubdomains && host.endsWith(`.${item.host}`)),
  );
  return rule
    ? { ...rule, observedHost: host, evidence: 'referrer-host' }
    : null;
}
