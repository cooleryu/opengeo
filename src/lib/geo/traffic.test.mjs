import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getTrafficRange, getTrafficSnapshot } from './traffic.ts';

// All configurations and responses are synthetic. No live analytics are read or written.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'opengeo-traffic-'));
after(() => rm(temporary, { recursive: true, force: true }));
const now = Date.parse('2026-10-27T10:00:00+08:00');
const range = getTrafficRange('2026-10-21', '2026-10-27', now);
const contextId = '11111111-1111-4111-8111-111111111111';
const replayId = '22222222-2222-4222-8222-222222222222';
const fakeToken = 'synthetic-test-token';
const env = {
  DATA_DIR: temporary,
  OPENGEO_UMAMI_URL: 'https://analytics.example.test',
  OPENGEO_UMAMI_TOKEN: fakeToken,
  OPENGEO_UMAMI_WEBSITE_IDS: JSON.stringify({ sample-project: contextId }),
};
const noNetwork = async () => {
  throw new Error('Unexpected network request');
};
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function mockTraffic(overrides = {}) {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const data = url.pathname.endsWith('/stats')
      ? (overrides.stats ?? { pageviews: 12, visitors: 5 })
      : url.searchParams.get('type') === 'referrer'
        ? (overrides.referrers ?? [
            { x: 'chatgpt.com', y: 3 },
            { x: 'github.com', y: 1 },
          ])
        : (overrides.pages ?? [
            { x: '/SampleProject/', y: 5 },
            { x: '/SampleProject/zh.html', y: 3 },
          ]);
    return response(data);
  };
  return { calls, fetch: mockFetch };
}

test('date windows use inclusive Beijing calendar days with today capped at now', () => {
  assert.deepEqual(range, {
    startDate: '2026-10-21',
    endDate: '2026-10-27',
    startAt: Date.parse('2026-10-21T00:00:00+08:00'),
    endAt: now,
    timezone: 'Asia/Shanghai',
  });
  assert.equal(getTrafficRange(null, null, now).startDate, '2026-09-28');
  assert.equal(
    getTrafficRange('2026-10-20', '2026-10-21', now).endAt,
    Date.parse('2026-10-21T23:59:59.999+08:00'),
  );
  for (const dates of [
    ['2026-02-30', '2026-03-01'],
    ['2026-10-27', null],
    ['2026-10-27', '2026-10-26'],
    ['2026-10-27', '2026-10-28'],
    ['', ''],
  ])
    assert.throws(() => getTrafficRange(...dates, now));
});

test('unconfigured projects do not use the SampleProject website or report zeros', async () => {
  for (const [projectId, configuration] of [
    ['sample-project-two', env],
    ['sample-project', { DATA_DIR: temporary }],
    ['sample-project', { ...env, OPENGEO_UMAMI_TOKEN: '' }],
  ]) {
    const snapshot = await getTrafficSnapshot(projectId, range, {
      env: configuration,
      fetch: noNetwork,
    });
    assert.equal(snapshot.status, 'not_configured');
    assert.equal(snapshot.summary, null);
    assert.equal(snapshot.fetchedAt, null);
    assert.deepEqual(snapshot.pages, []);
  }
});

test('v3 totals and ranked rows use one project, date window, and pageview scope', async () => {
  const mock = mockTraffic();
  const snapshot = await getTrafficSnapshot('sample-project', range, {
    env,
    fetch: mock.fetch,
    now,
  });
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.summary, { pageviews: 12, visitors: 5 });
  assert.deepEqual(snapshot.pages[0], { path: '/SampleProject/', visitors: 5 });
  assert.deepEqual(snapshot.referrers, [
    { referrer: 'chatgpt.com', visitors: 3 },
    { referrer: 'github.com', visitors: 1 },
  ]);
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  assert.equal(mock.calls.length, 3);
  for (const { url, options } of mock.calls) {
    assert.ok(url.pathname.startsWith(`/api/websites/${contextId}/`));
    assert.equal(url.searchParams.get('startAt'), String(range.startAt));
    assert.equal(url.searchParams.get('endAt'), String(range.endAt));
    assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai');
    assert.equal(url.searchParams.get('eventType'), '1');
    assert.equal(options.headers.Authorization, `Bearer ${fakeToken}`);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(mock.calls[1].url.searchParams.get('type'), 'path');
  assert.equal(mock.calls[2].url.searchParams.get('type'), 'referrer');
  assert.equal(JSON.stringify(snapshot).includes(fakeToken), false);
});

test('confirmed zero activity is empty; missing, invalid or partial responses are errors', async () => {
  const empty = mockTraffic({
    stats: { pageviews: 0, visitors: 0 },
    pages: [],
    referrers: [],
  });
  const snapshot = await getTrafficSnapshot('sample-project', range, {
    env,
    fetch: empty.fetch,
  });
  assert.equal(snapshot.status, 'empty');
  assert.deepEqual(snapshot.summary, { pageviews: 0, visitors: 0 });
  for (const overrides of [
    { stats: {} },
    { stats: { pageviews: 0, visitors: 0 } },
    { pages: { error: fakeToken } },
    { referrers: [{ x: 'chatgpt.com', y: -1 }] },
  ]) {
    const invalid = mockTraffic(overrides);
    const result = await getTrafficSnapshot('sample-project', range, {
      env,
      fetch: invalid.fetch,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'invalid_response');
    assert.equal(result.summary, null);
    assert.equal(JSON.stringify(result).includes(fakeToken), false);
  }
});

test('authorization, request failures, and timeouts never expose credentials or upstream text', async () => {
  for (const [mockFetch, code] of [
    [async () => response({ error: fakeToken }, 401), 'authorization'],
    [async () => response({ error: fakeToken }, 503), 'upstream'],
    [
      async () => {
        throw new Error(fakeToken);
      },
      'upstream',
    ],
    [
      async () => {
        throw new DOMException(fakeToken, 'TimeoutError');
      },
      'timeout',
    ],
  ]) {
    const snapshot = await getTrafficSnapshot('sample-project', range, {
      env,
      fetch: mockFetch,
    });
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.error.code, code);
    assert.equal(snapshot.summary, null);
    assert.equal(snapshot.fetchedAt, null);
    assert.equal(JSON.stringify(snapshot).includes(fakeToken), false);
  }
});

test('concurrent project reads keep their explicit website bindings', async () => {
  const configured = {
    ...env,
    OPENGEO_UMAMI_WEBSITE_IDS: JSON.stringify({
      sample-project: contextId,
      'sample-project-two': replayId,
    }),
  };
  const mock = mockTraffic();
  const snapshots = await Promise.all(
    ['sample-project', 'sample-project-two'].map((projectId) =>
      getTrafficSnapshot(projectId, range, {
        env: configured,
        fetch: mock.fetch,
      }),
    ),
  );
  assert.deepEqual(
    snapshots.map((item) => item.projectId),
    ['sample-project', 'sample-project-two'],
  );
  assert.equal(
    mock.calls.filter((call) => call.url.pathname.includes(contextId)).length,
    3,
  );
  assert.equal(
    mock.calls.filter((call) => call.url.pathname.includes(replayId)).length,
    3,
  );
});

test('private JSON is reread on demand and environment fields take precedence', async () => {
  const directory = path.join(temporary, 'reload');
  await mkdir(path.join(directory, 'data'), { recursive: true });
  const filename = path.join(directory, 'data', 'umami.json');
  const saved = {
    url: env.OPENGEO_UMAMI_URL,
    token: fakeToken,
    websiteIds: { sample-project: contextId },
    apiVersion: 3,
  };
  await writeFile(filename, JSON.stringify(saved), { mode: 0o600 });
  const mock = mockTraffic();
  assert.equal(
    (
      await getTrafficSnapshot('sample-project', range, {
        env: { DATA_DIR: directory },
        fetch: mock.fetch,
      })
    ).status,
    'ready',
  );
  await writeFile(
    filename,
    JSON.stringify({
      ...saved,
      websiteIds: { 'sample-project-two': replayId },
    }),
  );
  assert.equal(
    (
      await getTrafficSnapshot('sample-project', range, {
        env: { OPENGEO_UMAMI_CONFIG_FILE: filename },
        fetch: noNetwork,
      })
    ).status,
    'not_configured',
  );
  assert.equal(
    (
      await getTrafficSnapshot('sample-project', range, {
        env: { ...env, OPENGEO_UMAMI_CONFIG_FILE: filename },
        fetch: mock.fetch,
      })
    ).status,
    'ready',
  );
});

test('invalid credentials configuration is distinct from absence', async () => {
  for (const invalid of [
    { OPENGEO_UMAMI_WEBSITE_IDS: '{' },
    { OPENGEO_UMAMI_URL: `https://user:${fakeToken}@analytics.example.test` },
    { OPENGEO_UMAMI_URL: 'http://analytics.example.test' },
    { OPENGEO_UMAMI_API_VERSION: '9' },
  ]) {
    const snapshot = await getTrafficSnapshot('sample-project', range, {
      env: { ...env, ...invalid },
      fetch: noNetwork,
    });
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.error.code, 'configuration');
    assert.equal(JSON.stringify(snapshot).includes(fakeToken), false);
  }
});

test('explicit v2 configuration uses the legacy URL dimension and nested totals', async () => {
  const mock = mockTraffic({
    stats: {
      pageviews: { value: 12, prev: 30 },
      visitors: { value: 5, prev: 10 },
    },
  });
  const snapshot = await getTrafficSnapshot('sample-project', range, {
    env: { ...env, OPENGEO_UMAMI_API_VERSION: '2' },
    fetch: mock.fetch,
  });
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.summary, { pageviews: 12, visitors: 5 });
  assert.deepEqual(snapshot.pages[0], { path: '/SampleProject/', visitors: 5 });
  assert.deepEqual(snapshot.referrers[0], {
    referrer: 'chatgpt.com',
    visitors: 3,
  });
  assert.equal(mock.calls[1].url.searchParams.get('type'), 'url');
});

test('repeat pageviews retain one ranked visitor and absent external referrers stay absent', async () => {
  const mock = mockTraffic({
    stats: { pageviews: 4, visitors: 1 },
    pages: [{ x: '/SampleProject/', y: 1 }],
    referrers: [],
  });
  const snapshot = await getTrafficSnapshot('sample-project', range, {
    env,
    fetch: mock.fetch,
  });
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.summary, { pageviews: 4, visitors: 1 });
  assert.deepEqual(snapshot.pages, [{ path: '/SampleProject/', visitors: 1 }]);
  assert.equal(Object.hasOwn(snapshot.pages[0], 'pageviews'), false);
  assert.deepEqual(snapshot.referrers, []);
});
