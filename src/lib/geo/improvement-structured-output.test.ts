import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { GenerateObjectInput } from '@/lib/models/types';
import { withOneImprovementStructureRetry } from './improvement-structured-output';

const schema = z.object({ summary: z.string(), evidencePaths: z.array(z.string()).min(1) }).strict();
const request: GenerateObjectInput = { schema, messages: [{ role: 'system', content: 'Independent reviewer' },
  { role: 'user', content: 'Original evidence and full candidate only' }], options: { temperature: 0.2, maxTokens: 8000 } };
const valid = { summary: 'A valid result', evidencePaths: ['capture.md'] };

test('reported DeepSeek JSON syntax failure gets exactly one fresh format retry with the same evidence/schema', async () => {
  const calls: GenerateObjectInput[] = [];
  const model = withOneImprovementStructureRetry({ async generateObject(input) {
    calls.push(input);
    if (calls.length === 1) throw new Error("Error parsing response from DeepSeek: SyntaxError: Expected ',' or '}' after property value in JSON at position 1346");
    return valid;
  } });
  assert.deepEqual(await model.generateObject(request), valid);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].schema, schema);
  assert.deepEqual(calls[1].messages.slice(0, request.messages.length), request.messages);
  assert.equal(request.messages.length, 2);
  assert.equal(calls[1].options?.temperature, 0);
  assert.equal(calls[1].options?.maxTokens, request.options?.maxTokens);
  assert.equal(JSON.stringify(calls[1].messages).includes('position 1346'), false);
});

test('schema validation remains strict and another malformed response stops after two attempts', async () => {
  let calls = 0;
  const model = withOneImprovementStructureRetry({ async generateObject() { calls++; return { ...valid, evidencePaths: [], passed: true }; } });
  await assert.rejects(model.generateObject(request), z.ZodError);
  assert.equal(calls, 2);
});

test('the one retry is shared across comparison, proposal and review calls, not renewed at each stage', async () => {
  let calls = 0;
  const model = withOneImprovementStructureRetry({ async generateObject() {
    calls++;
    if (calls === 2) return valid;
    throw new SyntaxError('Invalid JSON');
  } });
  await model.generateObject(request);
  await assert.rejects(model.generateObject(request), SyntaxError);
  assert.equal(calls, 3);
});

test('network, configuration and incomplete provider responses are never retried as format errors', async () => {
  for (const message of ['503 Service Unavailable', '401 Unauthorized', 'Request timed out',
    'DeepSeek JSON response did not finish normally (length); no partial result was accepted']) {
    let calls = 0;
    const error = new Error(message);
    const model = withOneImprovementStructureRetry({ async generateObject() { calls++; throw error; } });
    await assert.rejects(model.generateObject(request), value => value === error);
    assert.equal(calls, 1);
  }
});
