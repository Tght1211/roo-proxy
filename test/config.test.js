const test = require('node:test');
const assert = require('node:assert/strict');

const { getDefaultConfig, normalizeConfig } = require('../server/config');
const { getRelayLoopConflict } = require('../server/proxy');

function withEnv(overrides, fn) {
  const previous = {
    ALL_PROXY: process.env.ALL_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
  };

  Object.entries(overrides).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    return fn();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
}

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


test('normalizeConfig rejects duplicate upstream names from imported config', () => {
  assert.throws(() => normalizeConfig({
    upstreams: [
      { name: 'dup', url: 'http://127.0.0.1:6578' },
      { name: 'dup', url: 'socks5://127.0.0.1:1080' },
    ],
  }), /重复的 upstream 名称/);
});


test('getDefaultConfig defaults to direct routing for unmatched traffic', () => {
  assert.deepEqual(getDefaultConfig(), {
    balance_strategy: 'round-robin',
    traffic_mode: 'rule',
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    upstreams: [],
    rules: [],
  });
});

test('getRelayLoopConflict detects env proxy loop on same local port', () => {
  withEnv({
    ALL_PROXY: null,
    HTTPS_PROXY: null,
    HTTP_PROXY: 'http://127.0.0.1:9999',
  }, () => {
    const conflict = getRelayLoopConflict(9999);
    assert.ok(conflict);
    assert.equal(conflict.proxyUrl, 'http://127.0.0.1:9999');
    assert.equal(conflict.localPort, 9999);
  });
});

test('getRelayLoopConflict ignores different relay port', () => {
  withEnv({
    ALL_PROXY: null,
    HTTPS_PROXY: null,
    HTTP_PROXY: 'http://127.0.0.1:6578',
  }, () => {
    assert.equal(getRelayLoopConflict(9999), null);
  });
});

test('getRelayLoopConflict uses same priority as runtime relay env selection', () => {
  withEnv({
    ALL_PROXY: 'socks5://127.0.0.1:9999',
    HTTPS_PROXY: 'http://127.0.0.1:6578',
    HTTP_PROXY: 'http://127.0.0.1:8888',
  }, () => {
    const conflict = getRelayLoopConflict(9999);
    assert.ok(conflict);
    assert.equal(conflict.proxyUrl, 'socks5://127.0.0.1:9999');
  });
});
