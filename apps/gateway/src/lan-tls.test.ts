import { X509Certificate } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { loadOrCreateLanTlsIdentity } from './lan-tls.js';

const IDENTITY_FILENAME = 'lan-tls-identity.json';
const LEGACY_CERTIFICATE_FILENAME = 'lan-tls-cert.pem';

describe('loadOrCreateLanTlsIdentity', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dash-lan-tls-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists one pinned TLS identity with a SHA-256 leaf fingerprint', async () => {
    const first = await loadOrCreateLanTlsIdentity(dataDir, ['192.168.1.20']);
    const second = await loadOrCreateLanTlsIdentity(dataDir, ['10.0.0.8']);

    expect(second).toEqual(first);
    expect(first.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(first.certificate).toContain('BEGIN CERTIFICATE');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      new X509Certificate(first.certificate).fingerprint256.replaceAll(':', '').toLowerCase(),
    ).toBe(first.fingerprint);
    expect((await stat(join(dataDir, IDENTITY_FILENAME))).mode & 0o777).toBe(0o600);
    expect(() =>
      createSecureContext({ key: first.privateKey, cert: first.certificate }),
    ).not.toThrow();
  });

  it('repairs an individually valid but mismatched persisted key and certificate', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'dash-lan-tls-other-'));
    try {
      const original = await loadOrCreateLanTlsIdentity(dataDir, ['192.168.1.20']);
      const other = await loadOrCreateLanTlsIdentity(otherDir, ['192.168.1.21']);
      await writeFile(
        join(dataDir, IDENTITY_FILENAME),
        JSON.stringify({ privateKey: original.privateKey, certificate: other.certificate }),
      );
      // Keep this regression red against the legacy two-file loader too.
      await writeFile(join(dataDir, LEGACY_CERTIFICATE_FILENAME), other.certificate);

      const repaired = await loadOrCreateLanTlsIdentity(dataDir, ['192.168.1.20']);

      expect(() =>
        createSecureContext({ key: repaired.privateKey, cert: repaired.certificate }),
      ).not.toThrow();
      expect(repaired.fingerprint).not.toBe(other.fingerprint);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('restores mode 0600 when replacing a corrupt identity file', async () => {
    const identityPath = join(dataDir, IDENTITY_FILENAME);
    await writeFile(identityPath, '{not-json', { mode: 0o644 });
    await chmod(identityPath, 0o644);

    const repaired = await loadOrCreateLanTlsIdentity(dataDir, ['192.168.1.20']);

    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
    expect(() =>
      createSecureContext({ key: repaired.privateKey, cert: repaired.certificate }),
    ).not.toThrow();
  });

  it('shares one generated identity across concurrent first-boot callers', async () => {
    const identities = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateLanTlsIdentity(dataDir, ['192.168.1.20'])),
    );

    expect(new Set(identities.map((identity) => identity.fingerprint))).toHaveProperty('size', 1);
    const persisted = JSON.parse(await readFile(join(dataDir, IDENTITY_FILENAME), 'utf8')) as {
      privateKey: string;
      certificate: string;
    };
    expect(persisted).toEqual({
      privateKey: identities[0].privateKey,
      certificate: identities[0].certificate,
    });
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
