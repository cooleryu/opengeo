import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { improvementModelSettings, loadImprovementModel } from './improvement-model';

const subscription = { enabled: true, connected: true, planEnabled: true, model: 'gpt-6-astra' };
const api = { configured: true, model: 'deepseek-flash' };

test('the enabled subscription is used throughout improvements, with no paid fallback', async () => {
  const settings = improvementModelSettings(subscription, api);
  assert.equal(settings.modelName, 'gpt-6-astra');
  let apiCalls = 0;
  const model = await loadImprovementModel({ settings: () => settings,
    subscription: timeoutMs => { assert.equal(timeoutMs, 1200000); return { generateObject: async () => { throw new Error('subscription unavailable'); } }; },
    api: async () => { apiCalls++; throw new Error('must not use the API'); },
  });
  await assert.rejects(model.generateObject({ schema: z.object({}), messages: [] }), /subscription unavailable/);
  assert.equal(apiCalls, 0);
  assert.equal(improvementModelSettings({ ...subscription, connected: false }, api).modelConfigured, false);
});

test('existing API configuration remains usable when subscription analysis is disabled', async () => {
  const settings = improvementModelSettings({ ...subscription, enabled: false }, api);
  const apiModel = { generateObject: async () => ({ ok: true }) };
  const model = await loadImprovementModel({ settings: () => settings,
    subscription: () => { throw new Error('subscription is disabled'); }, api: async () => apiModel });
  assert.equal(settings.modelName, 'deepseek-flash');
  assert.equal(model, apiModel);
});
