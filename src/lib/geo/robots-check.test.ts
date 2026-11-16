import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findBlockedAiBotsInRobotsTxt,
  resolveCheckableWebsiteOrigin,
} from './robots-check';

test('flags Cloudflare-style User-agent blocks against OpenAI & Google crawlers', () => {
  const robots = `
User-agent: GPTBot
Disallow: /

User-agent: OAI-SearchBot
Disallow: /
`;
  assert.deepEqual(findBlockedAiBotsInRobotsTxt(robots), ['OAI-SearchBot', 'GPTBot']);
});

test('ignores subpath Disallow rules so normal sites without root block trigger zero noise', () => {
  const robots = `
User-agent: *
Disallow: /api/
Disallow: /admin
`;
  assert.deepEqual(findBlockedAiBotsInRobotsTxt(robots), []);
});

test('respects specific User-agent Allow: / overriding wildcard Disallow: /', () => {
  const robots = `
User-agent: *
Disallow: /

User-agent: OAI-SearchBot
Allow: /
`;
  const blocked = findBlockedAiBotsInRobotsTxt(robots);
  assert.equal(blocked.includes('OAI-SearchBot'), false);
  assert.equal(blocked.includes('GPTBot'), true);
  assert.equal(blocked.includes('Googlebot'), true);
});

test('resolveCheckableWebsiteOrigin skips local IPs and shared platforms', () => {
  assert.equal(
    resolveCheckableWebsiteOrigin([
      'https://github.com/cooleryu/opengeo',
      'http://127.0.0.1:4327',
      'http://192.168.1.10/test',
      'https://dev.to/cooleryu/article',
    ]),
    null,
  );
  assert.equal(
    resolveCheckableWebsiteOrigin([
      'https://github.com/outwrite/app',
      'https://outwrite.ai/features',
    ]),
    'https://outwrite.ai',
  );
});
