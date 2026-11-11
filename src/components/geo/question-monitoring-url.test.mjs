import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQuestionMonitoringUrl } from './question-monitoring-url.ts';

test('old list links retain search and filters on the new list', () => {
  const url = new URL('http://localhost/?view=questions&project=demo&search=AI&questionSearch=stale&group=deferred&language=en&engine=google&kind=discovery&result=found');
  assert.equal(normalizeQuestionMonitoringUrl(url), true);
  assert.equal(url.searchParams.get('view'), 'question-plan');
  assert.equal(url.searchParams.get('questionSearch'), 'AI');
  assert.equal(url.searchParams.get('questionScope'), 'backlog');
  for (const [key, value] of Object.entries({ project: 'demo', language: 'en', engine: 'google', kind: 'discovery', result: 'found' }))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(normalizeQuestionMonitoringUrl(url), false);
});

test('exact historical answers and the return location survive migration', () => {
  const url = new URL('http://localhost/?view=questions&project=demo&batch=old&question=Q1&record=exact&history=all&sourceUrl=https%3A%2F%2Fexample.com&observationIndex=2&detail=answer&returnTo=%2F%3Fview%3Dcompetitor%26compareScroll%3D500');
  const preserved = [...url.searchParams].filter(([key]) => key !== 'view');
  normalizeQuestionMonitoringUrl(url);
  for (const [key, value] of preserved) assert.equal(url.searchParams.get(key), value);
});
