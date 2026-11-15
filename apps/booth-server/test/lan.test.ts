import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { makeBooth } from './harness';

// The container's only non-loopback IPv4 is TEST-NET 192.0.2.2: requests to it reach the server
// from a non-loopback socket, exactly like a tablet on the booth Wi-Fi.
const LAN_IP = '192.0.2.2';
let t: Awaited<ReturnType<typeof makeBooth>>;
let httpPort = 0, httpsPort = 0;
const servers: Array<http.Server | https.Server> = [];

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
function call(secure: boolean, method: string, path: string, o: { cookie?: string; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = o.json === undefined ? undefined : JSON.stringify(o.json);
    const req = (secure ? https : http).request({
      host: LAN_IP, port: secure ? httpsPort : httpPort, method, path,
      // Chain + name constraints are verified with openssl; here we test the access rules.
      rejectUnauthorized: false,
      headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const cookieOf = (r: Res) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;

afterAll(() => servers.forEach((s) => s.close()));

describe('LAN access', () => {
  it('waits for a private address instead of failing when the PC has none yet', async () => {
    const b = await makeBooth(() => ({ PMP_LAN: '1' })); // this container has no private IPv4
    const settled = await Promise.race([b.booth.lanReady.then(() => 'ready'), new Promise((r) => setTimeout(() => r('waiting'), 300))]);
    expect(settled).toBe('waiting');
    expect((await b.client().get('/api/auth/staff')).status).toBe(200); // booth PC unaffected
    await b.close();
  });

  it('serves paired devices only, over HTTPS', async () => {
    t = await makeBooth(() => ({ PMP_LAN: '1' }), { lanIps: [LAN_IP] });
    try {
      const tls = await t.booth.lanReady;
      expect(tls.ips).toEqual([LAN_IP]);
      // The listeners main.ts opens.
      const plain = http.createServer(t.booth.app).listen(0, '0.0.0.0');
      const secure = https.createServer({ key: tls.key, cert: tls.cert }, t.booth.app).listen(0, '0.0.0.0');
      servers.push(plain, secure);
      await Promise.all([plain, secure].map((s) => new Promise((r) => s.once('listening', r))));
      httpPort = (plain.address() as AddressInfo).port;
      httpsPort = (secure.address() as AddressInfo).port;
      await lanFlow();
    } finally {
      await t.close();
    }
  });
});

async function lanFlow() {
  const b = t;
  // Plain HTTP from the LAN: only the certificate setup page.
  expect((await call(false, 'GET', '/setup')).status).toBe(200);
  expect((await call(false, 'GET', '/ca.crt')).body).toContain('BEGIN CERTIFICATE');
  expect((await call(false, 'GET', '/api/auth/staff')).headers.location).toMatch(/^https:\/\/192\.0\.2\.2:\d+\/api\/auth\/staff$/);
  expect((await call(false, 'POST', '/api/auth/login', { json: {} })).status).toBe(403);

  // HTTPS without pairing: refused.
  expect(JSON.parse((await call(true, 'GET', '/api/auth/staff')).body).error).toBe('device_not_paired');
  expect((await call(true, 'GET', '/')).status).toBe(403);
  // Pairing can only start on the booth PC.
  const sup = b.client();
  await sup.login((await b.addUser('supervisor')).id);
  const pairRes = await sup.post('/api/devices/pair', { name: 'Tablette accueil' });
  expect(pairRes.status).toBe(200);
  const { pairUrl, setupQr } = await pairRes.json();
  expect(setupQr).toContain('<svg');
  const pairPath = new URL(pairUrl).pathname + new URL(pairUrl).search;

  const paired = await call(true, 'GET', pairPath);
  expect(paired.status).toBe(302);
  expect(paired.headers['set-cookie']?.[0]).toMatch(/pmp_device=.*HttpOnly; SameSite=Lax.*Secure/);
  const device = cookieOf(paired);
  expect((await call(true, 'GET', pairPath)).status).toBe(403); // one-time token

  expect((await call(true, 'GET', '/api/auth/staff', { cookie: device })).status).toBe(200);
  expect((await call(true, 'POST', '/api/devices/pair', { cookie: device, json: { name: 'x' } })).status).toBe(401); // needs staff + booth PC

  // Staff login over the LAN gets a Secure cookie.
  const host = await b.addUser('host');
  const login = await call(true, 'POST', '/api/auth/login', { cookie: device, json: { userId: host.id, secret: '1234' } });
  expect(login.status).toBe(200);
  expect(login.headers['set-cookie']?.[0]).toMatch(/Secure/);

  // Revoked → locked out.
  const [dev] = await (await sup.get('/api/devices')).json();
  expect((await sup.post(`/api/devices/${dev.id}/revoke`)).status).toBe(200);
  expect((await call(true, 'GET', '/api/auth/staff', { cookie: device })).status).toBe(403);
}
