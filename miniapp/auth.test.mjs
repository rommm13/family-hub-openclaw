import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from './auth.mjs';

// Synthetic test-only values (no real Telegram IDs, names, or tokens).
const BOT_TOKEN = '100001:SYNTHETIC_BOT_TOKEN_FOR_TESTS_ONLY';
const USER = { id: 900001, first_name: 'Test', username: 'synthetic_user' };
const NOW = 1_700_000_000_000; // fixed ms epoch

function buildInitData(fields, token = BOT_TOKEN) {
  const entries = Object.entries(fields).map(([k, v]) => [k, String(v)]);
  const dataCheckString = entries
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams([...entries, ['hash', hash]]).toString();
}

test('valid signature is accepted regardless of query parameter order', () => {
  const authDate = Math.floor(NOW / 1000);
  const base = {
    auth_date: authDate,
    query_id: 'AAHdF_SYNTH_QID',
    user: JSON.stringify(USER),
  };
  // Same fields, different insertion order in the final query string.
  const a = buildInitData({ query_id: base.query_id, user: base.user, auth_date: base.auth_date });
  const b = buildInitData({ user: base.user, auth_date: base.auth_date, query_id: base.query_id });
  const c = buildInitData({ auth_date: base.auth_date, user: base.user, query_id: base.query_id });
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  for (const raw of [a, b, c]) {
    const out = validateInitData(raw, BOT_TOKEN, NOW);
    assert.ok(out, 'expected valid user');
    assert.equal(out.id, USER.id);
  }
});

test('wrong bot token is rejected', () => {
  const raw = buildInitData({ auth_date: Math.floor(NOW / 1000), user: JSON.stringify(USER) });
  const out = validateInitData(raw, '100002:WRONG_SYNTHETIC_TOKEN', NOW);
  assert.equal(out, null);
});

test('tampered field is rejected', () => {
  const raw = buildInitData({ auth_date: Math.floor(NOW / 1000), user: JSON.stringify(USER) });
  const tampered = raw.replace('Test', 'Tampered');
  assert.notEqual(tampered, raw);
  const out = validateInitData(tampered, BOT_TOKEN, NOW);
  assert.equal(out, null);
});

test('expired auth_date is rejected', () => {
  const expired = Math.floor((NOW - 86_401_000) / 1000); // > 24h ago
  const raw = buildInitData({ auth_date: expired, user: JSON.stringify(USER) });
  const out = validateInitData(raw, BOT_TOKEN, NOW);
  assert.equal(out, null);
});

test('far-future auth_date is rejected', () => {
  const future = Math.floor((NOW + 120_000) / 1000); // > 60s ahead
  const raw = buildInitData({ auth_date: future, user: JSON.stringify(USER) });
  const out = validateInitData(raw, BOT_TOKEN, NOW);
  assert.equal(out, null);
});
