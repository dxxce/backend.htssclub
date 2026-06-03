/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Standalone LiveKit connectivity test.
 *
 * 1. Mints a join token exactly like SfuService does (AccessToken grant).
 * 2. Verifies the token (RoomServiceClient-style validation via the SDK).
 * 3. Opens the LiveKit RTC WebSocket (/rtc?...) and waits for the server's
 *    initial signal response — proving the server accepts our credentials.
 *
 * Usage:
 *   node scripts/test-livekit.js [wsUrl] [apiKey] [apiSecret] [room] [identity]
 * Defaults read from env / sensible fallbacks.
 */
const WebSocket = require('ws');
const { AccessToken, TokenVerifier } = require('livekit-server-sdk');

const WS_URL = process.argv[2] || process.env.LIVEKIT_URL || 'ws://192.168.1.86:7880';
const API_KEY = process.argv[3] || process.env.LIVEKIT_API_KEY || 'devkey';
const API_SECRET = process.argv[4] || process.env.LIVEKIT_API_SECRET || 'secret';
const ROOM = process.argv[5] || 'voice_testchannel';
const IDENTITY = process.argv[6] || 'tester-' + Date.now();

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}

async function main() {
  console.log('LiveKit connectivity test');
  console.log(`  url=${WS_URL} room=${ROOM} identity=${IDENTITY}`);
  console.log('');

  // ── 1. Mint token (same grant as SfuService) ──────────────────
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: IDENTITY,
    name: IDENTITY,
    ttl: '1h',
  });
  at.addGrant({
    room: ROOM,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  log(typeof token === 'string' && token.length > 0, 'minted access token');

  // ── 2. Verify the token locally (signature + grants) ──────────
  try {
    const verifier = new TokenVerifier(API_KEY, API_SECRET);
    const claims = await verifier.verify(token);
    const grantOk = claims?.video?.room === ROOM && claims?.video?.roomJoin === true;
    log(grantOk, `token verified (room=${claims?.video?.room}, join=${claims?.video?.roomJoin})`);
  } catch (e) {
    log(false, 'token verification failed: ' + e.message);
  }

  // ── 3. Real WebSocket handshake to the RTC endpoint ───────────
  const base = WS_URL.replace(/\/$/, '');
  const rtcUrl =
    `${base}/rtc?access_token=${encodeURIComponent(token)}` +
    `&auto_subscribe=1&sdk=js&protocol=15`;

  await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) {}
      resolve(code);
    };

    const ws = new WebSocket(rtcUrl);
    const timer = setTimeout(() => {
      log(false, 'no server response within 10s (timeout)');
      finish(1);
    }, 10000);

    ws.on('open', () => {
      log(true, 'WebSocket /rtc handshake accepted by LiveKit');
    });

    ws.on('message', (data) => {
      clearTimeout(timer);
      // LiveKit sends a binary SignalResponse (join) on success.
      const bytes = data instanceof Buffer ? data.length : (data.byteLength || 0);
      log(true, `received initial signal frame from server (${bytes} bytes) -> JOIN OK`);
      finish(0);
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      log(false, `server rejected handshake: HTTP ${res.statusCode}`);
      finish(1);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      log(false, 'WebSocket error: ' + err.message);
      finish(1);
    });
  });

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
