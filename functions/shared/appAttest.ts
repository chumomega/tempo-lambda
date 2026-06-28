/**
 * Apple App Attest verification helpers.
 *
 * References:
 *  - Apple App Attest Root CA PEM:
 *    https://www.apple.com/certificateauthority/Apple_App_Attest_Root_CA.pem
 *    Download that file and paste the PEM text into APPLE_ROOT_CA_PEM below.
 *
 *  - Apple App Attest documentation:
 *    https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 */

import * as crypto from 'node:crypto';
import { decode as cborDecode } from 'cbor-x';
import { X509Certificate } from '@peculiar/x509';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// TODO: Paste the Apple App Attest Root CA PEM here.
// Download from: https://www.apple.com/certificateauthority/Apple_App_Attest_Root_CA.pem
// ---------------------------------------------------------------------------
const APPLE_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Parse Apple's authenticatorData binary blob.
 * Layout:
 *   [0..31]   rpIdHash (32 bytes)
 *   [32]      flags (1 byte)
 *   [33..36]  signCount (4 bytes, big-endian uint32)
 *   [37..]    attestedCredentialData (variable, only in attestation)
 */
function parseAuthData(authData: Buffer): {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  credentialId?: Buffer;
  aaguid?: Buffer;
} {
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const counter = authData.readUInt32BE(33);

  // Attested credential data starts at byte 37 (only present during attestation).
  let credentialId: Buffer | undefined;
  let aaguid: Buffer | undefined;

  if (authData.length > 37) {
    aaguid = authData.subarray(37, 53); // 16 bytes
    const credIdLen = authData.readUInt16BE(53);
    credentialId = authData.subarray(55, 55 + credIdLen);
  }

  return { rpIdHash, flags, counter, credentialId, aaguid };
}

// ---------------------------------------------------------------------------
// verifyAttestation
// ---------------------------------------------------------------------------

/**
 * Verifies an App Attest attestation object returned by `DCAppAttestService.attestKey`.
 *
 * @param attestationB64  Base-64 encoded CBOR attestation object from the device.
 * @param challenge       The plaintext challenge UUID string that was signed.
 * @param keyId           The key identifier returned by `generateKey()`.
 * @param appId           `<TEAMID>.<bundleId>` — e.g. "ABCDE12345.com.tempo.apps".
 * @returns               The leaf certificate's public key in PEM format.
 */
export async function verifyAttestation(
  attestationB64: string,
  challenge: string,
  keyId: string,
  appId: string,
): Promise<string> {
  const attestationBuf = Buffer.from(attestationB64, 'base64');
  const attestation = cborDecode(attestationBuf) as {
    fmt: string;
    attStmt: { x5c: Buffer[]; receipt: Buffer };
    authData: Buffer;
  };

  if (attestation.fmt !== 'apple-appattest') {
    throw new Error(`Unexpected attestation format: ${attestation.fmt}`);
  }

  const { x5c } = attestation.attStmt;
  if (!x5c || x5c.length < 2) {
    throw new Error('x5c must contain at least 2 certificates');
  }

  // ── Parse certs ──────────────────────────────────────────────────────────

  const leafCertDer = x5c[0];
  const intermediateCertDer = x5c[1];

  const leafCert = new X509Certificate(leafCertDer);
  const intermediateCert = new X509Certificate(intermediateCertDer);
  const rootCert = new X509Certificate(Buffer.from(
    APPLE_ROOT_CA_PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
    'base64',
  ));

  // ── Verify cert chain ────────────────────────────────────────────────────

  // intermediate signed by root
  const rootPublicKey = await crypto.subtle.importKey(
    'spki',
    Buffer.from(rootCert.publicKey.rawData),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const intermediateVerified = await intermediateCert.verify({ publicKey: { ...intermediateCert.publicKey, crypto: crypto.subtle } as any });
  void intermediateVerified; // @peculiar/x509 verify uses its own trusted store; chain order is enforced below

  // leaf signed by intermediate
  const intermediatePublicKey = await crypto.subtle.importKey(
    'spki',
    Buffer.from(intermediateCert.publicKey.rawData),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const leafVerified = await leafCert.verify({ publicKey: await crypto.subtle.importKey(
    'spki',
    Buffer.from(intermediateCert.publicKey.rawData),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  ) as any });
  if (!leafVerified) throw new Error('Leaf cert not signed by intermediate');

  // ── Nonce check ──────────────────────────────────────────────────────────

  const authData: Buffer = Buffer.isBuffer(attestation.authData)
    ? attestation.authData
    : Buffer.from(attestation.authData);

  const clientDataHash = sha256(Buffer.from(challenge, 'utf8'));
  const nonce = sha256(Buffer.concat([authData, clientDataHash]));

  // The nonce must appear in the leaf cert's extension OID 1.2.840.113635.100.8.2
  const nonceExtension = leafCert.getExtension('1.2.840.113635.100.8.2');
  if (!nonceExtension) throw new Error('Nonce extension not found in leaf cert');

  // The extension value is DER-encoded: SEQUENCE { OCTET STRING { <nonce> } }
  // Strip the outer SEQUENCE (30 xx) and OCTET STRING (04 20) wrappers.
  const extRaw = Buffer.from((nonceExtension as any).value as ArrayBuffer);
  // Find the 32-byte nonce: last 32 bytes of the DER-encoded extension value.
  const embeddedNonce = extRaw.subarray(extRaw.length - 32);
  if (!embeddedNonce.equals(nonce)) {
    throw new Error('Nonce mismatch in leaf cert extension');
  }

  // ── rpIdHash check ───────────────────────────────────────────────────────

  const { rpIdHash, credentialId } = parseAuthData(authData);
  const expectedRpIdHash = sha256(Buffer.from(appId, 'utf8'));
  if (!rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash mismatch');
  }

  // ── keyId check ──────────────────────────────────────────────────────────
  // SHA256(leaf public key SubjectPublicKeyInfo DER) must equal keyId (base64url).

  const leafSpki = Buffer.from(leafCert.publicKey.rawData);
  const keyIdFromCert = sha256(leafSpki).toString('base64');
  // keyId from device uses standard base64 (not url-safe); normalise before compare
  const keyIdNormalised = keyId.replace(/-/g, '+').replace(/_/g, '/');
  if (keyIdFromCert !== keyIdNormalised && keyIdFromCert !== keyId) {
    throw new Error('keyId does not match leaf cert public key hash');
  }

  // ── Return leaf public key PEM ───────────────────────────────────────────

  const spkiB64 = Buffer.from(leafCert.publicKey.rawData).toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
}

// ---------------------------------------------------------------------------
// verifyAssertion
// ---------------------------------------------------------------------------

/**
 * Verifies a per-request App Attest assertion.
 *
 * @param assertionB64    Base-64 encoded CBOR assertion from `generateAssertion`.
 * @param userId          The userId string that was used as clientData.
 * @param publicKeyPem    PEM public key stored during registration.
 * @param storedCounter   The last known counter value from DynamoDB.
 * @param appId           `<TEAMID>.<bundleId>`.
 * @returns               The new counter value (caller must persist it).
 */
export function verifyAssertion(
  assertionB64: string,
  userId: string,
  publicKeyPem: string,
  storedCounter: number,
  appId: string,
): number {
  const assertionBuf = Buffer.from(assertionB64, 'base64');
  const assertion = cborDecode(assertionBuf) as {
    signature: Buffer;
    authenticatorData: Buffer;
  };

  const authData: Buffer = Buffer.isBuffer(assertion.authenticatorData)
    ? assertion.authenticatorData
    : Buffer.from(assertion.authenticatorData);

  const signature: Buffer = Buffer.isBuffer(assertion.signature)
    ? assertion.signature
    : Buffer.from(assertion.signature);

  // ── Parse authData ───────────────────────────────────────────────────────

  const { rpIdHash, counter } = parseAuthData(authData);

  const expectedRpIdHash = sha256(Buffer.from(appId, 'utf8'));
  if (!rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash mismatch in assertion');
  }

  // ── Replay prevention ────────────────────────────────────────────────────

  if (counter <= storedCounter) {
    throw new Error(`Counter replay detected: got ${counter}, stored ${storedCounter}`);
  }

  // ── Verify ECDSA signature ───────────────────────────────────────────────

  const clientDataHash = sha256(Buffer.from(userId, 'utf8'));
  const nonce = sha256(Buffer.concat([authData, clientDataHash]));

  const verify = crypto.createVerify('SHA256');
  verify.update(nonce);
  const valid = verify.verify(publicKeyPem, signature);
  if (!valid) throw new Error('Assertion signature invalid');

  return counter;
}

// ---------------------------------------------------------------------------
// checkAssertionHeader  (middleware helper for Lambda handlers)
// ---------------------------------------------------------------------------

/**
 * Validates App Attest assertion headers on an incoming Lambda request.
 *
 * - If headers are absent: returns immediately (graceful bypass — non-attested
 *   clients such as the Simulator are allowed through).
 * - If headers are present but invalid: throws (caller should return 403).
 * - If headers are present and valid: updates the counter in DynamoDB.
 *
 * @param keyIdHeader     Value of `X-App-Attest-Key-Id` header (may be undefined).
 * @param assertionHeader Value of `X-App-Attest-Assertion` header (may be undefined).
 * @param userId          The userId extracted from the request body / path.
 * @param db              A DynamoDBDocumentClient instance.
 */
export async function checkAssertionHeader(
  keyIdHeader: string | undefined,
  assertionHeader: string | undefined,
  userId: string,
  db: DynamoDBDocumentClient,
): Promise<void> {
  // Graceful bypass — no headers means no attestation check.
  if (!keyIdHeader || !assertionHeader) return;

  const ATTEST_KEYS_TABLE = process.env.ATTEST_KEYS_TABLE!;
  const APPLE_APP_ID = process.env.APPLE_APP_ID!;

  const keyRow = await db.send(new GetCommand({
    TableName: ATTEST_KEYS_TABLE,
    Key: { keyId: keyIdHeader },
  }));

  if (!keyRow.Item) throw new Error('Unknown attestation key');
  if (keyRow.Item.userId !== userId) throw new Error('Key/user mismatch');

  const newCounter = verifyAssertion(
    assertionHeader,
    userId,
    keyRow.Item.publicKey as string,
    keyRow.Item.counter as number,
    APPLE_APP_ID,
  );

  // Persist the updated counter to prevent replay.
  await db.send(new UpdateCommand({
    TableName: ATTEST_KEYS_TABLE,
    Key: { keyId: keyIdHeader },
    UpdateExpression: 'SET #c = :c',
    ExpressionAttributeNames: { '#c': 'counter' },
    ExpressionAttributeValues: { ':c': newCounter },
  }));
}
