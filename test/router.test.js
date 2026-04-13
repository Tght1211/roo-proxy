const test = require('node:test');
const assert = require('node:assert/strict');

const { matchRule, resolveRoute } = require('../server/router');

test('matchRule prefers exact domain over suffix and keyword', () => {
  const rule = matchRule('api.chatgpt.com', [
    { type: 'domain-keyword', value: 'chatgpt', action: 'proxy', upstreams: ['keyword'] },
    { type: 'domain-suffix', value: 'chatgpt.com', action: 'proxy', upstreams: ['suffix'] },
    { type: 'domain-exact', value: 'api.chatgpt.com', action: 'direct', upstreams: [] },
  ]);

  assert.deepEqual(rule, {
    type: 'domain-exact',
    value: 'api.chatgpt.com',
    action: 'direct',
    upstreams: [],
  });
});

test('resolveRoute falls back to default route when no rule matches', async () => {
  const route = await resolveRoute('example.org', {
    default_route: {
      action: 'proxy',
      upstreams: ['vpn-default'],
    },
    rules: [
      { type: 'domain-suffix', value: 'chatgpt.com', action: 'proxy', upstreams: ['residential'] },
    ],
  });

  assert.deepEqual(route, {
    source: 'default',
    rule: null,
    action: 'proxy',
    upstreams: ['vpn-default'],
    context: {
      hostname: 'example.org',
      addresses: [],
      geos: [],
    },
  });
});

test('resolveRoute matches IPv4 CIDR after DNS lookup', async () => {
  const route = await resolveRoute('example.org', {
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    rules: [
      { type: 'ipv4-cidr', value: '1.2.3.0/24', action: 'proxy', upstreams: ['residential'] },
    ],
  }, {
    lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    geoLookup: () => null,
  });

  assert.deepEqual(route.rule, {
    type: 'ipv4-cidr',
    value: '1.2.3.0/24',
    action: 'proxy',
    upstreams: ['residential'],
  });
});

test('resolveRoute matches geo-country and geo-region rules', async () => {
  const route = await resolveRoute('service.example', {
    default_route: {
      action: 'direct',
      upstreams: [],
    },
    rules: [
      { type: 'geo-country', value: 'US', action: 'proxy', upstreams: ['country-upstream'] },
      { type: 'geo-region', value: 'US-CA', action: 'proxy', upstreams: ['region-upstream'] },
    ],
  }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    geoLookup: () => ({ country: 'US', region: 'CA' }),
  });

  assert.deepEqual(route.rule, {
    type: 'geo-region',
    value: 'US-CA',
    action: 'proxy',
    upstreams: ['region-upstream'],
  });
});
