import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';

// Resolve the production extensionless import under Node's TypeScript runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './traffic' &&
      context.parentURL?.endsWith('/conversions.ts')
    )
      return nextResolve('./traffic.ts', context);
    return nextResolve(specifier, context);
  },
});
const { getConversionSnapshot } = await import('./conversions.ts');
const { getTrafficRange } = await import('./traffic.ts');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'opengeo-conversions-'));
after(() => rm(temporary, { recursive: true, force: true }));
const now = Date.parse('2026-10-28T12:00:00+08:00');
const range = getTrafficRange('2026-10-21', '2026-10-28', now);
const website = '11111111-1111-4111-8111-111111111111';
const token = 'synthetic-secret-only';
const env = {
  DATA_DIR: temporary,
  OPENGEO_UMAMI_URL: 'https://analytics.example.test',
  OPENGEO_UMAMI_TOKEN: token,
  OPENGEO_UMAMI_WEBSITE_IDS: JSON.stringify({ sample-project: website }),
};
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const contextValue = (
  source = 'chatgpt.com',
  page = '/SampleProject/',
  scope = 'tab-30m',
) => JSON.stringify([source, page, scope]);
const contextA = contextValue();
const contextB = contextValue('unknown', '/SampleProject/article.html', 'page');

function mock({
  values = [{ value: contextA, total: 12 }],
  totals = [10, 3],
  groups = {},
  change,
} = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    get peak() {
      return peak;
    },
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      if (url.pathname.endsWith('/event-data/values')) return response(values);
      const steps = JSON.parse(url.searchParams.get('steps'));
      const key = steps[0].filters?.[0]?.value;
      const counts = key ? (groups[key] ?? [5, 2]) : totals;
      const data = steps.map((step, i) => ({
        ...step,
        visitors: counts[i],
        dropoff: null,
        remaining: null,
      }));
      return response(change ? change(data, key) : data);
    },
  };
}

test('overall and joint journeys use native ordered visitor funnels and one date window', async () => {
  const upstream = mock({
    values: [
      { value: contextB, total: 3 },
      { value: contextA, total: 12 },
    ],
    groups: { [contextA]: [5, 2], [contextB]: [3, 0] },
  });
  const result = await getConversionSnapshot('sample-project', range, {
    env,
    fetch: upstream.fetch,
    now,
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.summary, {
    articleVisitors: 10,
    githubVisitors: 3,
    conversionRate: 0.3,
  });
  assert.deepEqual(result.journeys, [
    {
      source: 'chatgpt.com',
      landingPage: '/SampleProject/',
      entryScope: 'tab-30m',
      articleVisitors: 5,
      githubVisitors: 2,
      conversionRate: 0.4,
    },
    {
      source: 'unknown',
      landingPage: '/SampleProject/article.html',
      entryScope: 'page',
      articleVisitors: 3,
      githubVisitors: 0,
      conversionRate: 0,
    },
  ]);
  assert.equal(result.fetchedAt, new Date(now).toISOString());
  assert.equal(upstream.calls.length, 4);
  for (const { url, options } of upstream.calls) {
    assert.ok(url.pathname.startsWith(`/api/websites/${website}/`));
    assert.equal(url.searchParams.get('startAt'), String(range.startAt));
    assert.equal(url.searchParams.get('endAt'), String(range.endAt));
    assert.equal(
      url.searchParams.has('eventType'),
      false,
      'pageview scope must not erase custom events',
    );
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, undefined, 'only GET requests');
    if (url.pathname.endsWith('/funnels/stats')) {
      assert.equal(url.searchParams.get('window'), '30');
      const steps = JSON.parse(url.searchParams.get('steps'));
      assert.deepEqual(
        steps.map((row) => row.value),
        ['article_view', 'github_click'],
      );
      assert.deepEqual(
        steps[0].filters,
        steps[1].filters,
        'both stages must retain identical entry context',
      );
    } else {
      assert.equal(url.searchParams.get('eventName'), 'article_view');
      assert.equal(url.searchParams.get('propertyName'), 'entry_context');
      assert.equal(url.searchParams.get('dataType'), '1');
    }
  }
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('no article events is empty and zero denominators are unknown rates, not zero rates', async () => {
  const upstream = mock({ totals: [0, 0], values: [] });
  const result = await getConversionSnapshot('sample-project', range, {
    env,
    fetch: upstream.fetch,
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.summary, {
    articleVisitors: 0,
    githubVisitors: 0,
    conversionRate: null,
  });
  assert.deepEqual(result.journeys, []);
  assert.equal(upstream.calls.length, 2);
});

test('missing context is not fabricated from page/referrer metrics or filled with zero journeys', async () => {
  const upstream = mock({ values: [] });
  const result = await getConversionSnapshot('sample-project', range, {
    env,
    fetch: upstream.fetch,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.summary.articleVisitors, 10);
  assert.deepEqual(result.journeys, []);
  assert.equal(result.grouping.returnedValues, 0);
});

test('separate valid funnel reads are not rejected against an earlier overall response', async () => {
  const upstream = mock({ totals: [2, 1], groups: { [contextA]: [3, 2] } });
  const result = await getConversionSnapshot('sample-project', range, {
    env,
    fetch: upstream.fetch,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.summary.articleVisitors, 2);
  assert.equal(result.journeys[0].articleVisitors, 3);
  assert.equal(result.journeys[0].githubVisitors, 2);
  assert.equal(result.journeys[0].conversionRate, 2 / 3);
});

test('only valid recorded tuples are candidates; show ten groups and never query a Cartesian product', async () => {
  const values = Array.from({ length: 12 }, (_, i) => ({
    value: contextValue(`utm:source-${i}`, `/page-${i}`),
    total: 30 - i,
  }));
  values.push(
    { value: 'not-json', total: 100 },
    { value: JSON.stringify(['x', 'https://bad.test', 'page']), total: 50 },
  );
  const upstream = mock({ values });
  const result = await getConversionSnapshot('sample-project', range, {
    env,
    fetch: upstream.fetch,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.journeys.length, 10);
  assert.equal(result.grouping.invalidValues, 2);
  assert.equal(result.grouping.truncated, true);
  assert.equal(upstream.calls.length, 12);
  assert.ok(upstream.peak <= 3);
  assert.deepEqual(
    result.journeys.map((row) => row.source),
    Array.from({ length: 10 }, (_, i) => `utm:source-${i}`),
  );
});

test('malformed, reordered, increasing or mismatched-group funnel results remain errors', async () => {
  for (const change of [
    (data) => data.toReversed(),
    (data) => [{ ...data[0], visitors: null }, data[1]],
    (data) => [data[0], { ...data[1], visitors: 100 }],
    (data, key) => (key ? [data[0], { ...data[1], filters: [] }] : data),
  ]) {
    const upstream = mock({ change });
    const result = await getConversionSnapshot('sample-project', range, {
      env,
      fetch: upstream.fetch,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'invalid_response');
    assert.equal(result.summary, null);
    assert.deepEqual(result.journeys, []);
  }
});

test('authorization, upstream failures and timeouts never become zeros or expose response text', async () => {
  for (const [fetch, code] of [
    [async () => response({ error: token }, 403), 'authorization'],
    [async () => response({ error: token }, 503), 'upstream'],
    [
      async () => {
        throw new DOMException(token, 'TimeoutError');
      },
      'timeout',
    ],
  ]) {
    const result = await getConversionSnapshot('sample-project', range, {
      env,
      fetch,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, code);
    assert.equal(result.summary, null);
    assert.equal(result.fetchedAt, null);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('project binding and v3 requirement are preserved without upstream calls', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error('unexpected request');
  };
  const unbound = await getConversionSnapshot('sample-project-two', range, {
    env,
    fetch,
  });
  assert.equal(unbound.status, 'not_configured');
  assert.equal(unbound.summary, null);
  const old = await getConversionSnapshot('sample-project', range, {
    env: { ...env, OPENGEO_UMAMI_API_VERSION: '2' },
    fetch,
  });
  assert.equal(old.status, 'unsupported');
  assert.equal(old.summary, null);
  assert.equal(calls, 0);
});
