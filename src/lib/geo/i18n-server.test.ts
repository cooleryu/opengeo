import './test-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServerErrorPayload,
  localizeBrowserCollectSnapshot,
  localizeOnboardingRecord,
  resolveRequestUiLanguage,
  resolveUiLanguageFromHeaderValues,
  translateServerCode,
} from './i18n-server';
import type { BrowserCollectJobSnapshot } from './browser-collect-types';
import type { OnboardingRecord } from './project-onboarding-types';

function mockRequest(headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: {
      get(name: string) {
        return lower[name.toLowerCase()] ?? null;
      },
    },
  };
}

test('resolveRequestUiLanguage follows body -> cookie -> Accept-Language -> en priority', () => {
  assert.equal(resolveRequestUiLanguage(mockRequest()), 'en');
  assert.equal(
    resolveRequestUiLanguage(mockRequest({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' })),
    'zh',
  );
  assert.equal(
    resolveRequestUiLanguage(mockRequest({ 'accept-language': 'zh-TW,en;q=0.8' })),
    'zh',
  );
  assert.equal(
    resolveRequestUiLanguage(mockRequest({ 'accept-language': 'en-US,zh-CN;q=0.8' })),
    'en',
  );
  assert.equal(
    resolveRequestUiLanguage(
      mockRequest({
        'accept-language': 'zh-CN',
        cookie: 'other=1; opengeo-ui-lang=en',
      }),
    ),
    'en',
  );
  assert.equal(
    resolveRequestUiLanguage(
      mockRequest({
        'accept-language': 'en-US',
        cookie: 'opengeo-ui-lang=en',
      }),
      { uiLanguage: 'zh' },
    ),
    'zh',
  );
  assert.equal(resolveUiLanguageFromHeaderValues('zh', 'en-US'), 'zh');
  assert.equal(resolveUiLanguageFromHeaderValues(undefined, 'fr-FR,zh-CN;q=0.9'), 'en');
});

test('buildServerErrorPayload localizes codes, reason/field subkeys, and maps unknown to internal_error', () => {
  const enErr = buildServerErrorPayload(
    { code: 'invalid_url', status: 400, params: { reason: 'private_host' } },
    'en',
  );
  const zhErr = buildServerErrorPayload(
    { code: 'invalid_url', status: 400, params: { reason: 'private_host' } },
    'zh',
  );
  assert.equal(enErr.status, 400);
  assert.equal(enErr.body.code, 'invalid_url');
  assert.equal(zhErr.body.code, 'invalid_url');
  assert.match(enErr.body.error, /public website URL/i);
  assert.match(zhErr.body.error, /公开网站链接/);

  const unknown = buildServerErrorPayload(new Error('raw stack detail'), 'en');
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.code, 'internal_error');
  assert.equal(unknown.body.detail, 'raw stack detail');
  assert.doesNotMatch(unknown.body.error, /raw stack detail/);

  assert.match(translateServerCode('en', 'model_not_configured'), /Settings/i);
  assert.match(translateServerCode('zh', 'model_not_configured'), /设置/);

  const prepFailedEn = buildServerErrorPayload(
    {
      code: 'invalid_request',
      status: 422,
      params: { reason: 'question_prep_incomplete' },
      detail: '生成的问题未通过原文依据检查，已停止保存。',
    },
    'en',
  );
  assert.equal(prepFailedEn.status, 422);
  assert.match(prepFailedEn.body.error, /did not finish/i);
  assert.equal(prepFailedEn.body.detail, undefined, 'English responses must not leak Chinese internal detail');

  const prepFailedZh = buildServerErrorPayload(
    {
      code: 'invalid_request',
      status: 422,
      params: { reason: 'question_prep_incomplete' },
      detail: '生成的问题未通过原文依据检查，已停止保存。',
    },
    'zh',
  );
  assert.match(prepFailedZh.body.error, /问题准备未完成/);
  assert.equal(prepFailedZh.body.detail, '生成的问题未通过原文依据检查，已停止保存。');
});

test('localizeOnboardingRecord and localizeBrowserCollectSnapshot translate codes and keep legacy text', () => {
  const codedOnboarding: OnboardingRecord = {
    projectId: 'p1',
    kind: 'company',
    url: 'https://example.com',
    notes: '',
    status: 'analyzing',
    message: 'legacy zh',
    messageCode: 'onboarding.status.analyzing',
    messageParams: { count: 3 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  assert.match(localizeOnboardingRecord(codedOnboarding, 'en')!.message, /Saved 3 public sources/);
  assert.match(localizeOnboardingRecord(codedOnboarding, 'zh')!.message, /已保存 3 份公开资料/);

  const legacyOnboarding: OnboardingRecord = {
    projectId: 'p1',
    kind: 'company',
    url: 'https://example.com',
    notes: '',
    status: 'failed',
    message: 'Legacy raw message',
    error: 'Legacy raw error',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(localizeOnboardingRecord(legacyOnboarding, 'en')!.message, 'Legacy raw message');

  const codedSnap: BrowserCollectJobSnapshot = {
    jobId: 'j1',
    projectId: 'p1',
    engine: 'all',
    status: 'running',
    optimizationRunId: null,
    spaceId: null,
    completedCount: 1,
    totalCount: 8,
    currentIndex: 2,
    currentQuestionId: 'Q1',
    currentEngine: 'chatgpt',
    currentQuery: 'test',
    waitSeconds: null,
    message: '',
    messageCode: 'collect.asking',
    messageParams: { engine: 'ChatGPT', index: 2, total: 8 },
    error: null,
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(localizeBrowserCollectSnapshot(codedSnap, 'en').message, 'Asking ChatGPT (2/8)');
  assert.match(localizeBrowserCollectSnapshot(codedSnap, 'zh').message, /ChatGPT.*2\/8/);
});
