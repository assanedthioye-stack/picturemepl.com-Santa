import 'reflect-metadata'; // required by @peculiar/x509's DI container
import { randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 86_400_000;
const LEAF_DAYS = 397; // iOS rejects user-trusted leaf certs valid > 825 days; stay well under

// ─── minimal DER, only for NameConstraints (the library cannot encode IP/mask subtrees) ───
function der(tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Uint8Array.from([tag, ...len, ...body]);
}
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ipMask = (ip: string, bits: number) => {
  const mask = Array.from({ length: 4 }, (_, i) => (bits >= (i + 1) * 8 ? 255 : bits <= i * 8 ? 0 : (0xff << (8 - (bits % 8))) & 0xff));
  return Uint8Array.from([...ip.split('.').map(Number), ...mask]);
};

/** Permitted: *.local and private IPv4 ranges only. A stolen booth CA cannot impersonate real sites. */
export function nameConstraintsDer(): Uint8Array<ArrayBuffer> {
  const subtree = (generalName: Uint8Array) => der(0x30, generalName);
  const permitted = cat(
    subtree(der(0x82, new TextEncoder().encode('local'))), // [2] dNSName
    subtree(der(0x87, ipMask('10.0.0.0', 8))),            // [7] iPAddress + mask
    subtree(der(0x87, ipMask('172.16.0.0', 12))),
    subtree(der(0x87, ipMask('192.168.0.0', 16))),
  );
  return der(0x30, der(0xa0, permitted)); // NameConstraints { permittedSubtrees [0] }
}

const isPrivateV4 = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

export function lanIps(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal && isPrivateV4(i.address))
    .map((i) => i.address);
}

const serial = () => { const b = randomBytes(16); b[0]! &= 0x7f; return b.toString('hex'); };
const pemKey = async (k: CryptoKey) => x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', k as any), 'PRIVATE KEY');

export interface TlsMaterial { key: string; cert: string; caCert: string; ips: string[] }

/**
 * Per-booth CA (10 years, name-constrained) + a server cert for the current LAN IPs.
 * The CA is created once; the server cert is reissued when the IPs change or it nears expiry,
 * so tablets only ever install the CA once.
 */
export async function ensureTls(dir: string, ips = lanIps()): Promise<TlsMaterial> {
  if (ips.length === 0) throw new Error('no_lan_address');
  mkdirSync(dir, { recursive: true });
  const f = (n: string) => path.join(dir, n);

  if (!existsSync(f('ca.crt')) || !existsSync(f('ca.key'))) {
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: `CN=Picture Me Please Booth CA ${randomBytes(3).toString('hex').toUpperCase()}, O=Picture Me Please`,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 3650 * DAY),
      keys,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        new x509.Extension('2.5.29.30', true, nameConstraintsDer()),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    // shortcut: keys are plain files under Data\tls (internal disk, admin-only ACL); move to DPAPI via Electron safeStorage if booths get shared PCs
    writeFileSync(f('ca.key'), await pemKey(keys.privateKey), { mode: 0o600 });
    writeFileSync(f('ca.crt'), ca.toString('pem'));
  }
  const caCert = new x509.X509Certificate(readFileSync(f('ca.crt'), 'utf8'));
  const caKey = await webcrypto.subtle.importKey('pkcs8', x509.PemConverter.decode(readFileSync(f('ca.key'), 'utf8'))[0]!, ALG, false, ['sign']);

  const wanted = [...new Set(ips)].sort();
  const meta = existsSync(f('server.json')) ? JSON.parse(readFileSync(f('server.json'), 'utf8')) as { ips: string[]; notAfter: number } : null;
  const fresh = meta && JSON.stringify(meta.ips) === JSON.stringify(wanted) && meta.notAfter - Date.now() > 30 * DAY
    && existsSync(f('server.crt')) && existsSync(f('server.key'));
  if (!fresh) {
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
    const notAfter = new Date(Date.now() + LEAF_DAYS * DAY);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: 'CN=Picture Me Please Booth',
      issuer: caCert.subject,
      notBefore: new Date(Date.now() - DAY),
      notAfter,
      signingKey: caKey,
      publicKey: keys.publicKey,
      signingAlgorithm: ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(wanted.map((value) => ({ type: 'ip' as const, value }))),
        await x509.AuthorityKeyIdentifierExtension.create(caCert),
      ],
    });
    writeFileSync(f('server.key'), await pemKey(keys.privateKey), { mode: 0o600 });
    writeFileSync(f('server.crt'), cert.toString('pem'));
    writeFileSync(f('server.json'), JSON.stringify({ ips: wanted, notAfter: notAfter.getTime() }));
  }
  const caPem = readFileSync(f('ca.crt'), 'utf8');
  // Full chain (server + CA) so clients that trust the CA can build the path.
  const chain = `${readFileSync(f('server.crt'), 'utf8').trimEnd()}\n${caPem.trimEnd()}\n`;
  return { key: readFileSync(f('server.key'), 'utf8'), cert: chain, caCert: caPem, ips: wanted };
}
