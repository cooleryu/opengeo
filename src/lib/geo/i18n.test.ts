import './test-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveProjectTargetLanguage,
  resolveProjectUiLanguage,
  translateUi,
  UI_MESSAGES,
  type UiMessageKey,
} from './i18n';

test('resolveProjectUiLanguage respects explicit uiLanguage and infers legacy Chinese projects cleanly', () => {
  assert.equal(resolveProjectUiLanguage(undefined), 'en');
  assert.equal(resolveProjectUiLanguage({ uiLanguage: 'en', summaryOrDescription: '中文描述' }), 'en');
  assert.equal(resolveProjectUiLanguage({ uiLanguage: 'zh', summaryOrDescription: 'English desc' }), 'zh');
  assert.equal(resolveProjectUiLanguage({ summaryOrDescription: '开源、本地运行的 AI 搜索可见性工作台' }), 'zh');
  assert.equal(resolveProjectUiLanguage({ summaryOrDescription: 'Local AI gateway' }), 'en');
});

test('resolveProjectTargetLanguage defaults to en and follows project or batch observations cleanly', () => {
  assert.equal(resolveProjectTargetLanguage(undefined, undefined), 'en');
  assert.equal(resolveProjectTargetLanguage({ targetLanguage: 'zh' }, null), 'zh');
  assert.equal(resolveProjectTargetLanguage({ targetLanguage: 'en' }, null), 'en');

  const zhOnlyBatch = {
    questions: [
      {
        observations: [{ language: 'zh' as const }],
      },
    ],
  } as unknown as Parameters<typeof resolveProjectTargetLanguage>[1];

  const enOnlyBatch = {
    questions: [
      {
        observations: [{ language: 'en' as const }],
      },
    ],
  } as unknown as Parameters<typeof resolveProjectTargetLanguage>[1];

  const mixedBatch = {
    questions: [
      {
        observations: [{ language: 'zh' as const }, { language: 'en' as const }],
      },
    ],
  } as unknown as Parameters<typeof resolveProjectTargetLanguage>[1];

  // Unset targetLanguage still reads legacy Chinese-only batch, and prefers English once English is observed
  assert.equal(resolveProjectTargetLanguage({}, zhOnlyBatch), 'zh');
  assert.equal(resolveProjectTargetLanguage({}, enOnlyBatch), 'en');
  assert.equal(resolveProjectTargetLanguage({}, mixedBatch), 'en');

  // Explicit English project reads English in mixed batch, falls back safely if only legacy zh observations exist
  assert.equal(resolveProjectTargetLanguage({ targetLanguage: 'en' }, mixedBatch), 'en');
  assert.equal(resolveProjectTargetLanguage({ targetLanguage: 'en' }, zhOnlyBatch), 'zh');
});

test('UI dictionary provides non-empty strings for zh and en and interpolates variables', () => {
  const zhKeys = Object.keys(UI_MESSAGES.zh) as UiMessageKey[];
  const enKeys = Object.keys(UI_MESSAGES.en) as UiMessageKey[];
  assert.deepEqual(enKeys.sort(), zhKeys.sort());
  for (const key of zhKeys) {
    assert.ok(UI_MESSAGES.zh[key].trim().length > 0, `zh missing text for ${key}`);
    assert.ok(UI_MESSAGES.en[key].trim().length > 0, `en missing text for ${key}`);
  }
  assert.equal(
    translateUi('en', 'overview.confirmQuestionsBtn', { count: 8 }),
    'Confirm 8 Questions & Continue',
  );
  assert.equal(
    translateUi('zh', 'overview.confirmQuestionsBtn', { count: 8 }),
    '确认这 8 道问题，准备搜索',
  );
});
