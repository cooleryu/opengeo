import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigModelProvider, UIConfigField } from './types';
import { mergeProviderConfig, publicModelProvider } from './public-config';

const fields: UIConfigField[] = [
  { key: 'apiKey', name: 'API Key', type: 'string', required: true, description: '', scope: 'server' },
  { key: 'accessToken', name: 'Token', type: 'password', required: false, description: '', scope: 'server' },
  { key: 'baseURL', name: 'URL', type: 'string', required: true, description: '', scope: 'server' },
];

const providerWith = (config: Record<string, any>): ConfigModelProvider => ({
  id: 'synthetic-provider',
  name: 'Synthetic connection',
  type: 'openai',
  config,
  chatModels: [{ key: 'synthetic-model', name: 'Synthetic model' }],
  embeddingModels: [],
  hash: 'synthetic-private-hash',
});

test('public providers hide password fields and legacy apiKey without changing stored data', () => {
  const provider = providerWith({
    apiKey: 'synthetic-api-secret',
    accessToken: 'synthetic-token-secret',
    baseURL: 'https://example.test/v1',
  });
  const before = structuredClone(provider);
  const visible = publicModelProvider(provider, fields);

  assert.deepEqual(visible.config, { apiKey: '', accessToken: '', baseURL: 'https://example.test/v1' });
  assert.deepEqual([...visible.configuredSecrets].sort(), ['accessToken', 'apiKey']);
  assert.equal(visible.hash, '');
  assert.equal(visible.name, provider.name);
  assert.deepEqual(visible.chatModels, provider.chatModels);
  assert.equal(JSON.stringify(visible).includes('synthetic-api-secret'), false);
  assert.equal(JSON.stringify(visible).includes('synthetic-token-secret'), false);
  assert.deepEqual(provider, before);
});

test('blank or omitted passwords keep stored keys while new passwords replace them', () => {
  const previous = { apiKey: 'synthetic-old-key', accessToken: 'synthetic-old-token', baseURL: 'https://old.example.test/v1' };
  const before = structuredClone(previous);
  for (const secretValues of [{}, { apiKey: '', accessToken: '' }, { apiKey: '   ', accessToken: '   ' }]) {
    const updated = mergeProviderConfig(previous, { ...secretValues, baseURL: 'https://next.example.test/v1' }, fields);
    assert.equal(updated.apiKey, previous.apiKey);
    assert.equal(updated.accessToken, previous.accessToken);
    assert.equal(updated.baseURL, 'https://next.example.test/v1');
  }
  const updated = mergeProviderConfig(previous, { apiKey: 'synthetic-new-key', accessToken: 'synthetic-new-token', baseURL: '' }, fields);
  assert.equal(updated.apiKey, 'synthetic-new-key');
  assert.equal(updated.accessToken, 'synthetic-new-token');
  assert.equal(updated.baseURL, '', 'ordinary fields can still be cleared');
  assert.deepEqual(previous, before);
});

test('providers without credentials retain their ordinary configuration', () => {
  const publicFields = fields.filter((field) => field.key === 'baseURL');
  const provider = { ...providerWith({ baseURL: 'http://localhost:11434' }), type: 'ollama' };
  const visible = publicModelProvider(provider, publicFields);
  assert.deepEqual(visible.config, provider.config);
  assert.deepEqual(visible.configuredSecrets, []);
  assert.deepEqual(
    mergeProviderConfig(provider.config, { baseURL: 'http://localhost:11435' }, publicFields),
    { baseURL: 'http://localhost:11435' },
  );
});
