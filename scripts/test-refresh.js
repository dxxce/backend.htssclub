/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies refresh token is returned in the body and that /refresh works
 * via the request body (no cookie), for launcher/mobile-style clients.
 * Usage: node scripts/test-refresh.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;
const stamp = Date.now();
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

async function api(p, body) {
  const res = await fetch(`${API}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}

async function main() {
  console.log(`Refresh token test -> ${BASE}\n`);

  const creds = { username: `rt_${stamp}`, email: `rt_${stamp}@example.com`, password: 'StrongP@ss1' };
  const reg = await api('/auth/register', creds);
  check(typeof reg.refreshToken === 'string' && reg.refreshToken.length > 0, 'register returns refreshToken in body');
  check(!!reg.refreshExpiresAt, 'register returns refreshExpiresAt');
  check(!!reg.accessToken, 'register returns accessToken');

  // Refresh using the body token (no cookie sent by fetch here).
  const refreshed = await api('/auth/refresh', { refreshToken: reg.refreshToken });
  check(!!refreshed.accessToken, 'refresh via body returns a new accessToken');
  check(typeof refreshed.refreshToken === 'string' && refreshed.refreshToken.length > 0, 'refresh returns a rotated refreshToken');
  check(refreshed.refreshToken !== reg.refreshToken, 'rotated refreshToken differs from the original');

  // Old token should now be invalid (rotation invalidates it).
  let oldRejected = false;
  try { await api('/auth/refresh', { refreshToken: reg.refreshToken }); }
  catch (e) { oldRejected = /401|Refresh token mismatch|Session/.test(e.message); }
  check(oldRejected, 'old refreshToken is rejected after rotation');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
