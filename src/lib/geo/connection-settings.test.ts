import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { GET, PUT } from '@/app/api/geo/settings/route';
import { getGeoConnectionSettings, getGeoModelConnection, loadGeoModel, saveGeoConnectionSettings, shouldUseChatGPTSubscription } from './connection-settings';
import { collectionKey, getCollectionConfig } from './providers/config';
import { buildQwenRequest } from './providers/qwen';
import { withGeoProject } from './projects';

const environmentNames = ['DATA_DIR', 'OPENGEO_LLM_MODEL', 'OPENGEO_LLM_API_KEY', 'OPENGEO_LLM_BASE_URL', 'OPENGEO_VANE_PROVIDER_ID',
  'DEEPSEEK_API_KEY', 'ARK_API_KEY', 'DOUBAO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENGEO_DOUBAO_MODEL', 'OPENGEO_QWEN_MODEL'];
let previousEnvironment: Array<[string, string | undefined]>;
let temporary: string;
const previousFetch = globalThis.fetch;

beforeEach(() => {
  previousEnvironment = environmentNames.map(name => [name, process.env[name]]);
  for (const name of environmentNames) delete process.env[name];
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-settings-'));
  process.env.DATA_DIR = temporary;
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
const settingsFile = () => path.join(temporary, 'data/geo-settings.json');

test('environment fallback, blank-key preservation and independent shared sections never expose secrets', async () => {
  Object.assign(process.env, { OPENGEO_LLM_MODEL: 'original-model', OPENGEO_LLM_API_KEY: 'synthetic-model-key',
    OPENGEO_LLM_BASE_URL: 'https://api.deepseek.com/v1', DEEPSEEK_API_KEY: 'synthetic-search-key', DASHSCOPE_API_KEY: 'synthetic-qwen-key' });
  assert.equal(getGeoConnectionSettings().model.source, 'environment');
  assert.equal(getGeoConnectionSettings().model.provider, 'deepseek');
  assert.equal(fs.existsSync(settingsFile()), false);
  saveGeoConnectionSettings({ section: 'model', values: { model: 'next-model', apiKey: '' } });
  assert.equal(getGeoModelConnection().apiKey, 'synthetic-model-key');
  saveGeoConnectionSettings({ section: 'qwen', values: { model: 'next-qwen' } });
  assert.equal(collectionKey('qwen'), 'synthetic-qwen-key');
  saveGeoConnectionSettings({ section: 'deepseek', values: { apiKey: 'synthetic-saved-search-key' } });
  saveGeoConnectionSettings({ section: 'deepseek', values: { apiKey: '  ' } });
  assert.equal(collectionKey('deepseek'), 'synthetic-saved-search-key');
  assert.equal(getGeoModelConnection().model, 'next-model');
  assert.equal(getCollectionConfig('qwen').model, 'next-qwen');
  assert.equal(getCollectionConfig('doubao').model, 'doubao-seed-2-0-lite-260428');
  assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.equal(saved.model.apiKey, undefined, 'environment credentials are not unnecessarily copied');
  assert.deepEqual(withGeoProject('sample-project-two', getGeoConnectionSettings), getGeoConnectionSettings());
  const response = await GET();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const serialized = await response.text();
  assert.equal(serialized.includes('synthetic-'), false);
  assert.equal(serialized.includes('apiKey'), false);
});

test('invalid settings and endpoint changes without a new key leave the previous file intact', async () => {
  saveGeoConnectionSettings({ section: 'model', values: { provider: 'custom', baseURL: 'https://first.example.test/v1', model: 'first', apiKey: 'synthetic-first' } });
  const previous = fs.readFileSync(settingsFile(), 'utf8');
  for (const input of [
    { section: 'model', values: { provider: 'unknown' } },
    { section: 'model', values: { model: '' } },
    { section: 'model', values: { baseURL: 'https://secret-user:secret-key@example.test/v1' } },
    { section: 'model', values: { baseURL: 'https://example.test/v1?key=secret-key' } },
    { section: 'model', values: { baseURL: 'https://second.example.test/v1', apiKey: '' } },
    { section: 'model', values: { provider: 'deepseek' } },
    { section: 'qwen', values: { apiKey: 'bad\nkey' } },
    { section: 'deepseek', values: { model: 'not-supported' } },
  ]) {
    assert.throws(() => saveGeoConnectionSettings(input));
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), previous);
  }
  const request = new NextRequest('http://localhost/api/geo/settings', { method: 'PUT', headers: { origin: 'http://unrelated.example', 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'deepseek', values: { apiKey: 'synthetic-rejected' } }) });
  assert.equal((await PUT(request)).status, 403);
  const malformed = new NextRequest('http://localhost/api/geo/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"apiKey":"synthetic-private' });
  const response = await PUT(malformed);
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes('synthetic-private'), false);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), previous);
});

test('saving takes effect on the next real model request and new collection request without a restart', async () => {
  const calls: Array<{ url: string; key: string | null; model: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://first.example.test/') || url.startsWith('https://second.example.test/'));
    calls.push({ url, key: new Headers(init?.headers).get('authorization'), model: JSON.parse(String(init?.body)).model });
    return new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'synthetic',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}', refusal: null }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  saveGeoConnectionSettings({ section: 'model', values: { provider: 'custom', baseURL: 'https://first.example.test/v1', model: 'first', apiKey: 'synthetic-first' } });
  const input = { schema: z.object({ ok: z.boolean() }), messages: [{ role: 'user' as const, content: 'Return JSON with ok=true.' }] };
  assert.deepEqual(await (await loadGeoModel()).generateObject(input), { ok: true });
  saveGeoConnectionSettings({ section: 'model', values: { baseURL: 'https://second.example.test/v1', model: 'second', apiKey: 'synthetic-second' } });
  assert.deepEqual(await (await loadGeoModel()).generateObject(input), { ok: true });
  assert.deepEqual(calls, [
    { url: 'https://first.example.test/v1/chat/completions', key: 'Bearer synthetic-first', model: 'first' },
    { url: 'https://second.example.test/v1/chat/completions', key: 'Bearer synthetic-second', model: 'second' },
  ]);
  saveGeoConnectionSettings({ section: 'qwen', values: { model: 'qwen-first', apiKey: 'synthetic-qwen-first' } });
  const frozenCollection = getCollectionConfig('qwen');
  saveGeoConnectionSettings({ section: 'qwen', values: { model: 'qwen-second', apiKey: 'synthetic-qwen-second' } });
  const newRequest = buildQwenRequest('synthetic query', getCollectionConfig('qwen'), collectionKey('qwen'));
  assert.equal(newRequest.body.model, 'qwen-second');
  assert.equal(newRequest.headers.Authorization, 'Bearer synthetic-qwen-second');
  assert.equal(frozenCollection.model, 'qwen-first', 'existing follow-up protocols keep their original model');
  const oldRequest = buildQwenRequest('synthetic query', frozenCollection, collectionKey('qwen'));
  assert.equal(oldRequest.body.model, 'qwen-first');
  assert.equal(oldRequest.headers.Authorization, 'Bearer synthetic-qwen-second');
});

test('opening settings preserves Vane compatibility and never rewrites its configuration', () => {
  process.env.OPENGEO_VANE_PROVIDER_ID = 'legacy-provider';
  process.env.OPENGEO_LLM_MODEL = 'legacy-model';
  fs.mkdirSync(path.join(temporary, 'data'));
  const configFile = path.join(temporary, 'data/config.json');
  const original = JSON.stringify({ modelProviders: [{ id: 'legacy-provider', type: 'openai', config: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'synthetic-legacy-key' } }] });
  fs.writeFileSync(configFile, original);
  assert.equal(getGeoConnectionSettings().model.source, 'vane');
  assert.equal(getGeoModelConnection().vaneProviderId, 'legacy-provider');
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  assert.equal(fs.existsSync(settingsFile()), false);
  saveGeoConnectionSettings({ section: 'qwen', values: { apiKey: 'synthetic-qwen-key' } });
  assert.equal(getGeoModelConnection().vaneProviderId, 'legacy-provider');
  saveGeoConnectionSettings({ section: 'model', values: { model: 'adopted-model', apiKey: '' } });
  assert.equal(getGeoModelConnection().vaneProviderId, undefined);
  assert.equal(getGeoModelConnection().apiKey, 'synthetic-legacy-key');
  assert.equal(getGeoModelConnection().baseURL, 'https://api.deepseek.com/v1');
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('shouldUseChatGPTSubscription yields to configured API model when disconnected and supports DEEPSEEK_API_KEY env', () => {
  assert.equal(shouldUseChatGPTSubscription({ enabled: false, connected: true }, true), false);
  assert.equal(shouldUseChatGPTSubscription({ enabled: true, connected: false }, true), false);
  assert.equal(shouldUseChatGPTSubscription({ enabled: true, connected: false }, false), true);
  assert.equal(shouldUseChatGPTSubscription({ enabled: true, connected: true }, true), true);
  assert.equal(shouldUseChatGPTSubscription({ enabled: true }, true), true);

  Object.assign(process.env, { OPENGEO_LLM_MODEL: 'deepseek-flash', OPENGEO_LLM_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_API_KEY: 'synthetic-ds-key' });
  const conn = getGeoModelConnection();
  assert.equal(conn.provider, 'deepseek');
  assert.equal(conn.configured, true);
  assert.equal(conn.apiKey, 'synthetic-ds-key');
});
