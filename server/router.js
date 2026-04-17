const dns = require('node:dns/promises');
const net = require('node:net');
const geoip = require('geoip-lite');
const ipaddr = require('ipaddr.js');

const HOST_RESOLUTION_CACHE_TTL_MS = 60_000;
const hostResolutionCache = new Map();

function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function toRuleObject(rule) {
  if (!rule) {
    return null;
  }

  if (typeof rule === 'string') {
    const value = normalizeHostname(rule);
    if (!value) {
      return null;
    }

    return {
      type: 'domain-suffix',
      value,
      action: 'proxy',
      upstreams: [],
    };
  }

  if (rule.domain != null) {
    const value = normalizeHostname(rule.domain);
    if (!value) {
      return null;
    }

    return {
      type: 'domain-suffix',
      value,
      action: rule.action === 'direct' ? 'direct' : 'proxy',
      upstreams: Array.isArray(rule.upstreams)
        ? rule.upstreams.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    };
  }

  const type = String(rule.type || '').trim();
  const value = String(rule.value || '').trim();
  if (!type || !value) {
    return null;
  }

  return {
    type,
    value,
    action: rule.action === 'direct' ? 'direct' : 'proxy',
    upstreams: Array.isArray(rule.upstreams)
      ? rule.upstreams.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

function formatRuleLabel(rule) {
  if (!rule) {
    return null;
  }

  if (rule.type && rule.value) {
    return `${rule.type}:${rule.value}`;
  }

  if (rule.domain) {
    return `domain-suffix:${rule.domain}`;
  }

  return null;
}

function getRulePriority(rule, matchInfo = {}) {
  if (!rule) {
    return 0;
  }

  if (rule.type === 'domain-exact') {
    return 700_000 + rule.value.length;
  }

  if (rule.type === 'domain-suffix') {
    return 600_000 + rule.value.length;
  }

  if (rule.type === 'domain-keyword') {
    return 500_000 + rule.value.length;
  }

  if (rule.type === 'ipv4-cidr' || rule.type === 'ipv6-cidr') {
    return 400_000 + (matchInfo.prefixLength || 0);
  }

  if (rule.type === 'geo-region') {
    return 300_000 + rule.value.length;
  }

  if (rule.type === 'geo-country') {
    return 200_000 + rule.value.length;
  }

  return 0;
}

function isAddressResolutionRequired(rules = []) {
  return rules.some((entry) => {
    const rule = toRuleObject(entry);
    return rule && ['ipv4-cidr', 'ipv6-cidr', 'geo-country', 'geo-region'].includes(rule.type);
  });
}

function dedupeStrings(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeResolvedAddress(address) {
  if (!address) {
    return null;
  }

  const normalized = net.isIP(address) ? ipaddr.parse(address).toNormalizedString() : null;
  return normalized;
}

function toGeoRegionCode(geo) {
  if (!geo || !geo.country || !geo.region) {
    return null;
  }

  return `${String(geo.country).toUpperCase()}-${String(geo.region).toUpperCase()}`;
}

async function resolveAddresses(hostname, options = {}) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return [];
  }

  if (net.isIP(normalizedHostname)) {
    return [normalizeResolvedAddress(normalizedHostname)];
  }

  const cached = hostResolutionCache.get(normalizedHostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.addresses;
  }

  const lookup = options.lookup || dns.lookup;
  try {
    const records = await lookup(normalizedHostname, { all: true, verbatim: true });
    const addresses = dedupeStrings(
      records
        .map((item) => normalizeResolvedAddress(item && item.address))
        .filter(Boolean),
    );

    hostResolutionCache.set(normalizedHostname, {
      addresses,
      expiresAt: Date.now() + HOST_RESOLUTION_CACHE_TTL_MS,
    });
    return addresses;
  } catch (error) {
    hostResolutionCache.set(normalizedHostname, {
      addresses: [],
      expiresAt: Date.now() + HOST_RESOLUTION_CACHE_TTL_MS,
    });
    return [];
  }
}

function matchCidr(address, cidr) {
  try {
    const parsedAddress = ipaddr.parse(address);
    const [networkAddress, prefixLength] = ipaddr.parseCIDR(cidr);
    return {
      matched: parsedAddress.kind() === networkAddress.kind() && parsedAddress.match(networkAddress, prefixLength),
      prefixLength,
    };
  } catch (error) {
    return {
      matched: false,
      prefixLength: 0,
    };
  }
}

async function buildMatchContext(hostname, rules = [], options = {}) {
  const normalizedHostname = normalizeHostname(hostname);
  const needsAddressResolution = isAddressResolutionRequired(rules);
  const addresses = needsAddressResolution ? await resolveAddresses(normalizedHostname, options) : [];
  const geoLookup = options.geoLookup || geoip.lookup;
  const geos = addresses.map((address) => ({
    address,
    geo: typeof geoLookup === 'function' ? geoLookup(address) : null,
  }));

  return {
    hostname: normalizedHostname,
    addresses,
    geos,
  };
}

function matchRuleAgainstContext(rule, context) {
  if (!rule) {
    return { matched: false, score: 0 };
  }

  if (rule.type === 'domain-exact') {
    const matched = context.hostname === rule.value;
    return {
      matched,
      score: matched ? getRulePriority(rule) : 0,
    };
  }

  if (rule.type === 'domain-suffix') {
    const matched = context.hostname === rule.value || context.hostname.endsWith(`.${rule.value}`);
    return {
      matched,
      score: matched ? getRulePriority(rule) : 0,
    };
  }

  if (rule.type === 'domain-keyword') {
    const matched = Boolean(context.hostname && context.hostname.includes(rule.value));
    return {
      matched,
      score: matched ? getRulePriority(rule) : 0,
    };
  }

  if (rule.type === 'ipv4-cidr' || rule.type === 'ipv6-cidr') {
    let bestPrefixLength = 0;
    const matched = context.addresses.some((address) => {
      const result = matchCidr(address, rule.value);
      if (result.matched && result.prefixLength > bestPrefixLength) {
        bestPrefixLength = result.prefixLength;
      }
      return result.matched;
    });

    return {
      matched,
      score: matched ? getRulePriority(rule, { prefixLength: bestPrefixLength }) : 0,
    };
  }

  if (rule.type === 'geo-country') {
    const matched = context.geos.some(({ geo }) => geo && String(geo.country || '').toUpperCase() === rule.value);
    return {
      matched,
      score: matched ? getRulePriority(rule) : 0,
    };
  }

  if (rule.type === 'geo-region') {
    const matched = context.geos.some(({ geo }) => toGeoRegionCode(geo) === rule.value);
    return {
      matched,
      score: matched ? getRulePriority(rule) : 0,
    };
  }

  return {
    matched: false,
    score: 0,
  };
}

function matchRule(hostname, rules = []) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return null;
  }

  let matchedRule = null;
  let matchedScore = 0;
  const context = { hostname: normalizedHostname, addresses: [], geos: [] };

  for (const entry of rules) {
    const rule = toRuleObject(entry);
    const result = matchRuleAgainstContext(rule, context);
    if (result.matched && result.score > matchedScore) {
      matchedRule = rule;
      matchedScore = result.score;
    }
  }

  return matchedRule;
}

async function resolveRoute(hostname, config = {}, options = {}) {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const context = await buildMatchContext(hostname, rules, options);

  // 流量模式短路：global/direct 直接绕开规则匹配
  const mode = typeof config.traffic_mode === 'string' ? config.traffic_mode : 'rule';
  if (mode === 'direct') {
    return { source: 'mode-direct', rule: null, action: 'direct', upstreams: [], context };
  }
  if (mode === 'global') {
    return { source: 'mode-global', rule: null, action: 'proxy', upstreams: [], context };
  }

  // rule 模式（默认）：按规则匹配
  let matchedRule = null;
  let matchedScore = 0;

  for (const entry of rules) {
    const rule = toRuleObject(entry);
    // 跳过被禁用的规则
    if (rule && rule.enabled === false) continue;
    const result = matchRuleAgainstContext(rule, context);
    if (result.matched && result.score > matchedScore) {
      matchedRule = rule;
      matchedScore = result.score;
    }
  }

  if (matchedRule) {
    return {
      source: 'rule',
      rule: matchedRule,
      action: matchedRule.action,
      upstreams: matchedRule.upstreams || [],
      context,
    };
  }

  const defaultRoute = config.default_route && typeof config.default_route === 'object'
    ? config.default_route
    : { action: 'direct', upstreams: [] };

  return {
    source: 'default',
    rule: null,
    action: defaultRoute.action === 'proxy' ? 'proxy' : 'direct',
    upstreams: Array.isArray(defaultRoute.upstreams) ? defaultRoute.upstreams : [],
    context,
  };
}

module.exports = {
  buildMatchContext,
  formatRuleLabel,
  matchRule,
  matchRuleAgainstContext,
  normalizeHostname,
  resolveRoute,
  resolveAddresses,
  toGeoRegionCode,
  toRuleObject,
};
