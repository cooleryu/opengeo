import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identifyAiReferral } from './ai-referrals.ts';

test('known hosts match bare Umami domains and HTTP(S) referrer URLs', () => {
  for (const source of [
    'chatgpt.com',
    'https://chatgpt.com/c/example?utm_source=test',
    'HTTP://CHATGPT.COM:80/',
    ' chatgpt.com. ',
  ]) {
    const match = identifyAiReferral(source);
    assert.equal(match?.observedHost, 'chatgpt.com');
    assert.equal(match?.evidence, 'referrer-host');
  }
  for (const [source, expectedHost] of [
    ['chat.openai.com', 'chat.openai.com'],
    ['claude.ai', 'claude.ai'],
    ['perplexity.ai', 'perplexity.ai'],
    ['www.perplexity.ai', 'www.perplexity.ai'],
    ['app.perplexity.ai', 'app.perplexity.ai'],
    ['gemini.google.com', 'gemini.google.com'],
    ['copilot.microsoft.com', 'copilot.microsoft.com'],
  ]) {
    assert.equal(identifyAiReferral(source)?.host, expectedHost);
  }
  assert.equal(identifyAiReferral('news.ycombinator.com'), null);
});

test('lookalike suffixes, unlisted subdomains, and credential tricks do not match', () => {
  for (const source of [
    'chatgpt.com.evil.example',
    'https://chatgpt.com.evil.example/',
    'notchatgpt.com',
    'unlisted.chatgpt.com',
    'https://chatgpt.com@evil.example/',
    'https://evil.example@chatgpt.com/',
    'https://evil.example/chatgpt.com',
    'javascript://chatgpt.com/',
  ]) {
    assert.equal(identifyAiReferral(source), null, source);
  }
});

test('missing, malformed, and unknown sources remain unclassified', () => {
  for (const source of [
    null,
    undefined,
    '',
    '   ',
    '/chatgpt.com',
    'chatgpt.com?source=ai',
    'not a hostname',
    'https://example.com/',
  ]) {
    assert.equal(identifyAiReferral(source), null, String(source));
  }
});
