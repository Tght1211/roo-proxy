function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function matchRule(hostname, rules = []) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return null;
  }

  let matchedRule = null;

  for (const rule of rules) {
    const normalizedRule = normalizeHostname(rule);
    if (!normalizedRule) {
      continue;
    }

    if (normalizedHostname === normalizedRule || normalizedHostname.endsWith(`.${normalizedRule}`)) {
      if (!matchedRule || normalizedRule.length > matchedRule.length) {
        matchedRule = normalizedRule;
      }
    }
  }

  return matchedRule;
}

module.exports = {
  matchRule,
  normalizeHostname,
};
