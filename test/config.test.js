const test = require('node:test');
const assert = require('node:assert/strict');

const { getDefaultConfig, normalizeConfig } = require('../server/config');

test('normalizeConfig keeps backward compatibility for legacy string rules', () => {
  const config = normalizeConfig({
    upstreams: [
      { name: 'residential', url: 'socks5://user:pass@127.0.0.1:1080' },
    ],
    rules: ['claude.ai', 'claude.ai', 'chatgpt.com'],
  });

  assert.deepEqual(config.default_route, {
    action: 'direct',
    upstreams: [],
  });
  assert.deepEqual(config.rules, [
    { type: 'domain-suffix', value: 'claude.ai', action: 'proxy', upstreams: [] },
    { type: 'domain-suffix', value: 'chatgpt.com', action: 'proxy', upstreams: [] },
  ]);
});

test('normalizeConfig supports explicit default route and per-rule upstream binding', () => {
  const config = normalizeConfig({
    balance_strategy: 'weighted',
    upstreams: [
      { name: 'vpn-default', url: 'http://127.0.0.1:6578' },
      { name: 'residential', url: 'socks5://user:pass@127.0.0.1:1080' },
    ],
    default_route: {
      action: 'proxy',
      upstreams: ['vpn-default'],
    },
    rules: [
      {
        type: 'domain-exact',
        value: 'chatgpt.com',
        action: 'proxy',
        upstreams: ['residential'],
      },
      {
        type: 'geo-country',
        value: 'US',
        action: 'direct',
      },
    ],
  });

  assert.equal(config.balance_strategy, 'weighted');
  assert.deepEqual(config.default_route, {
    action: 'proxy',
    upstreams: ['vpn-default'],
  });
  assert.deepEqual(config.rules, [
    {
      type: 'domain-exact',
      value: 'chatgpt.com',
      action: 'proxy',
      upstreams: ['residential'],
    },
    {
      type: 'geo-country',
      value: 'US',
      action: 'direct',
      upstreams: [],
    },
  ]);
});

test('normalizeConfig supports CIDR and geo-region rule values', () => {
  const config = normalizeConfig({
    upstreams: [
      { name: 'residential', url: 'socks5://user:pass@127.0.0.1:1080' },
    ],
    rules: [
      { type: 'ipv4-cidr', value: '1.2.3.0/24', upstreams: ['residential'] },
      { type: 'ipv6-cidr', value: '2001:db8::/32', upstreams: ['residential'] },
      { type: 'geo-region', value: 'us-ca', upstreams: ['residential'] },
      { type: 'domain-keyword', value: 'chatgpt', upstreams: ['residential'] },
    ],
  });

  assert.deepEqual(config.rules, [
    { type: 'ipv4-cidr', value: '1.2.3.0/24', action: 'proxy', upstreams: ['residential'] },
    { type: 'ipv6-cidr', value: '2001:db8:0:0:0:0:0:0/32', action: 'proxy', upstreams: ['residential'] },
    { type: 'geo-region', value: 'US-CA', action: 'proxy', upstreams: ['residential'] },
    { type: 'domain-keyword', value: 'chatgpt', action: 'proxy', upstreams: ['residential'] },
  ]);
});

test('normalizeConfig rejects routes that reference missing upstreams', () => {
  assert.throws(() => normalizeConfig({
    upstreams: [
      { name: 'vpn-default', url: 'http://127.0.0.1:6578' },
    ],
    default_route: {
      action: 'proxy',
      upstreams: ['missing-upstream'],
    },
  }), /missing-upstream/);
});

test('getDefaultConfig defaults to direct routing for unmatched traffic', () => {
  assert.deepEqual(getDefaultConfig(), {
    balance_strategy: 'round-robin',
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    upstreams: [],
    rules: [],
  });
});
