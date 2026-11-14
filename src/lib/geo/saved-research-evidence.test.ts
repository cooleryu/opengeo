import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSavedResearchEvidence } from './saved-research-evidence';
import type { ResearchObservation } from './research-types';

const observation: ResearchObservation = { engine: 'chatgpt', language: 'zh', query: '如何找到品牌？',
  recordedAt: '2026-11-06T07:48:05.039Z', conditions: '个人账号中文回答', status: 'not_observed',
  summary: '摘要不是原文', sources: [], evidencePath: 'capture.json' };
const legacy = { schemaVersion: 1, engine: observation.engine, query: observation.query,
  capturedAt: observation.recordedAt, conditions: observation.conditions, answer_text: '原始回答内容。' };

test('registered browser JSON accepts primary ChatGPT and generated Google answers with unknown completeness preserved', () => {
  const result = readSavedResearchEvidence(observation, () => JSON.stringify(legacy));
  assert.equal(result.available, true);
  assert.equal(result.answerText, legacy.answer_text);
  assert.match(result.boundary, /完整性未确认/);
  const google = { ...observation, engine: 'google' as const };
  const record = { ...legacy, engine: 'google', overviewStatus: 'generated' };
  assert.equal(readSavedResearchEvidence(google, () => JSON.stringify(record)).available, true);
  assert.equal(readSavedResearchEvidence(google, () => JSON.stringify({ ...record, overviewStatus: 'not_generated' })).available, false);
});

test('browser JSON rejects wrong question, platform, time, conditions and summary-only records', () => {
  for (const change of [{ query: 'other' }, { engine: 'google' }, { capturedAt: 'other' },
    { conditions: 'other' }, { answer_text: '', summary: '不能用来替代正文' }, { schemaVersion: 999 }]) {
    assert.equal(readSavedResearchEvidence(observation, () => JSON.stringify({ ...legacy, ...change })).available, false);
  }
});

test('ingested answer files must match their original capture and its conditions', () => {
  const input = { captureId: 'capture-one', engine: observation.engine, language: 'zh', entryType: 'web_answer',
    query: observation.query, recordedAt: observation.recordedAt, pageUrl: 'https://chatgpt.com/c/saved',
    conditions: { mode: 'temporary', region: 'unknown', loginState: 'signed_in' },
    answerText: '完整回答。', answerComplete: true, citationsComplete: false, citationSource: 'unknown' };
  const saved = { ...observation, id: 'browser:capture-one', answerPath: 'answer.md', entryType: 'web_answer' as const,
    conditions: JSON.stringify({ ...input.conditions, originalURL: input.pageUrl, answerComplete: input.answerComplete,
      citationsComplete: input.citationsComplete, citationSource: input.citationSource }) };
  const read = (file: string) => file === 'capture.json' ? JSON.stringify({ version: 1, input }) : input.answerText;
  const result = readSavedResearchEvidence(saved, read);
  assert.equal(result.available, true);
  assert.deepEqual(result.evidencePaths, ['capture.json', 'answer.md']);
  assert.equal(readSavedResearchEvidence(saved, file => file === 'answer.md' ? '被换掉的内容' : read(file)).available, false);
  assert.equal(readSavedResearchEvidence({ ...saved, id: 'browser:another' }, read).available, false);
  assert.equal(readSavedResearchEvidence({ ...saved, conditions: 'other' }, read).available, false);
  assert.equal(readSavedResearchEvidence({ ...saved, language: 'en' }, read).available, false);
});
