import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupPublicProjectHost, type PublicProjectDnsRuntime } from './project-public-network';

const publicIp = '140.82.114.5';
function runtime(changes: Partial<PublicProjectDnsRuntime> = {}): PublicProjectDnsRuntime {
  return { system: async () => [{ address: publicIp, family: 4 }],
    publicDns: async () => { throw new Error('Unexpected public DNS call'); },
    trustedDoh: async () => { throw new Error('Unexpected DoH call'); }, ...changes };
}

test('ordinary public addresses are used unchanged without alternate resolvers', async () => {
  assert.deepEqual(await lookupPublicProjectHost('api.github.com', runtime()), [{ address: publicIp, family: 4 }]);
});

test('known proxy fake-IP answers are replaced with validated public DNS answers', async () => {
  let calls = 0;
  const addresses = await lookupPublicProjectHost('api.github.com', runtime({
    system: async () => [{ address: '198.18.0.52', family: 4 }],
    publicDns: async () => { calls += 1; return [publicIp]; },
  }));
  assert.deepEqual(addresses, [{ address: publicIp, family: 4 }]);
  assert.equal(calls, 1);
});

test('fixed trusted HTTPS DNS is used once when public UDP is blocked or still fake-IP', async () => {
  for (const publicDns of [async () => { throw new Error('UDP unavailable'); }, async () => ['198.19.1.2']]) {
    let calls = 0;
    const addresses = await lookupPublicProjectHost('api.github.com', runtime({
      system: async () => [{ address: '198.18.0.52', family: 4 }], publicDns,
      trustedDoh: async hostname => { calls += 1; assert.equal(hostname, 'api.github.com'); return [publicIp]; },
    }));
    assert.deepEqual(addresses, [{ address: publicIp, family: 4 }]);
    assert.equal(calls, 1);
  }
});

test('dual-stack proxy placeholders are re-resolved without connecting to reserved IPv6 addresses', async () => {
  for (const ipv6 of ['2001:2::2d', '2001:0002:0000:0001::2d']) {
    const addresses = await lookupPublicProjectHost('raw.githubusercontent.com', runtime({
      system: async () => [{ address: '198.18.0.190', family: 4 }, { address: ipv6, family: 6 }],
      publicDns: async () => [publicIp],
    }));
    assert.deepEqual(addresses, [{ address: publicIp, family: 4 }]);
  }
  let alternateCalls = 0;
  for (const ipv6 of ['::1', 'fd00::1', '2001:2:1::1']) {
    await assert.rejects(() => lookupPublicProjectHost('unsafe.example.com', runtime({
      system: async () => [{ address: '198.18.0.190', family: 4 }, { address: ipv6, family: 6 }],
      publicDns: async () => { alternateCalls++; return [publicIp]; },
    })), /非公开地址/);
  }
  await assert.rejects(() => lookupPublicProjectHost('2001:2::2d', runtime()), /非公开地址/);
  assert.equal(alternateCalls, 0);
});

test('private, loopback, mixed and literal fake-IP addresses never trigger an alternate lookup', async () => {
  let calls = 0;
  for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], [publicIp, '198.18.0.52']]) {
    await assert.rejects(() => lookupPublicProjectHost('unsafe.example.com', runtime({
      system: async () => addresses.map(address => ({ address, family: 4 })),
      publicDns: async () => { calls += 1; return [publicIp]; },
      trustedDoh: async () => { calls += 1; return [publicIp]; },
    })), /非公开地址/);
  }
  await assert.rejects(() => lookupPublicProjectHost('198.18.0.52', runtime()), /非公开地址/);
  assert.equal(calls, 0);
});

test('alternate DNS private or fake-IP results are never returned for a connection', async () => {
  let dohCalls = 0;
  await assert.rejects(() => lookupPublicProjectHost('unsafe.example.com', runtime({
    system: async () => [{ address: '198.18.0.52', family: 4 }], publicDns: async () => ['127.0.0.1'],
    trustedDoh: async () => { dohCalls += 1; return [publicIp]; },
  })), /非公开地址/);
  assert.equal(dohCalls, 0);
  for (const address of ['127.0.0.1', '198.18.0.52', '::1']) {
    await assert.rejects(() => lookupPublicProjectHost('unsafe.example.com', runtime({
      system: async () => [{ address: '198.18.0.52', family: 4 }], publicDns: async () => ['198.18.0.70'],
      trustedDoh: async () => [address],
    })), /未能确认真实公开地址/);
  }
});
