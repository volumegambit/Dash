import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generate } from 'selfsigned';

const IDENTITY_FILENAME = 'lan-tls-identity.json';
const LEGACY_KEY_FILENAME = 'lan-tls-key.pem';
const LEGACY_CERTIFICATE_FILENAME = 'lan-tls-cert.pem';
const identityLoads = new Map<string, Promise<LanTlsIdentity>>();

export interface LanTlsIdentity {
  privateKey: string;
  certificate: string;
  /** Lowercase SHA-256 fingerprint of the DER leaf certificate. */
  fingerprint: string;
}

function validate(value: unknown): LanTlsIdentity {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('privateKey' in value) ||
    typeof value.privateKey !== 'string' ||
    !('certificate' in value) ||
    typeof value.certificate !== 'string'
  ) {
    throw new Error('Invalid LAN TLS identity');
  }

  const certificate = new X509Certificate(value.certificate);
  const privatePublicKey = createPublicKey(createPrivateKey(value.privateKey)).export({
    type: 'spki',
    format: 'der',
  });
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  if (!privatePublicKey.equals(certificatePublicKey)) {
    throw new Error('LAN TLS private key does not match its certificate');
  }

  return {
    privateKey: value.privateKey,
    certificate: value.certificate,
    fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
}

async function writeIdentityAtomically(dataDir: string, identity: LanTlsIdentity): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const identityPath = join(dataDir, IDENTITY_FILENAME);
  const temporaryPath = join(dataDir, `${IDENTITY_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  const payload = JSON.stringify({
    privateKey: identity.privateKey,
    certificate: identity.certificate,
  });
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryFile = await open(temporaryPath, 'wx', 0o600);
    await temporaryFile.writeFile(payload, 'utf8');
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, identityPath);
    await chmod(identityPath, 0o600);

    // Persist the rename where the platform supports syncing directory handles.
    try {
      const directory = await open(dataDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file itself is already synced and atomically installed.
    }
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function loadPersistedIdentity(dataDir: string): Promise<LanTlsIdentity> {
  const identityPath = join(dataDir, IDENTITY_FILENAME);
  const identity = validate(JSON.parse(await readFile(identityPath, 'utf8')));
  await chmod(identityPath, 0o600);
  return identity;
}

async function loadLegacyIdentity(dataDir: string): Promise<LanTlsIdentity> {
  const keyPath = join(dataDir, LEGACY_KEY_FILENAME);
  const certificatePath = join(dataDir, LEGACY_CERTIFICATE_FILENAME);
  const identity = validate({
    privateKey: await readFile(keyPath, 'utf8'),
    certificate: await readFile(certificatePath, 'utf8'),
  });
  await Promise.all([chmod(keyPath, 0o600), chmod(certificatePath, 0o600)]);
  return identity;
}

async function generateIdentity(lanAddresses: string[]): Promise<LanTlsIdentity> {
  const now = new Date();
  const notBeforeDate = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfterDate = new Date(now);
  notAfterDate.setUTCFullYear(notAfterDate.getUTCFullYear() + 10);
  const addresses = [...new Set(['127.0.0.1', '::1', ...lanAddresses])];
  const generated = await generate([{ name: 'commonName', value: 'Dash Gateway' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          ...addresses.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  return validate({ privateKey: generated.private, certificate: generated.cert });
}

async function loadOrCreate(dataDir: string, lanAddresses: string[]): Promise<LanTlsIdentity> {
  try {
    return await loadPersistedIdentity(dataDir);
  } catch {
    // First boot or a corrupt identity falls through to migration/generation.
  }

  try {
    const legacyIdentity = await loadLegacyIdentity(dataDir);
    await writeIdentityAtomically(dataDir, legacyIdentity);
    return legacyIdentity;
  } catch {
    // A missing, incomplete, or mismatched legacy pair is replaced atomically.
  }

  const generated = await generateIdentity(lanAddresses);
  await writeIdentityAtomically(dataDir, generated);
  return generated;
}

/** Load or mint the persistent leaf certificate pinned by native LAN clients. */
export async function loadOrCreateLanTlsIdentity(
  dataDir: string,
  lanAddresses: string[],
): Promise<LanTlsIdentity> {
  const key = resolve(dataDir);
  const activeLoad = identityLoads.get(key);
  if (activeLoad) return activeLoad;

  const load = loadOrCreate(key, lanAddresses);
  identityLoads.set(key, load);
  try {
    return await load;
  } finally {
    if (identityLoads.get(key) === load) identityLoads.delete(key);
  }
}
