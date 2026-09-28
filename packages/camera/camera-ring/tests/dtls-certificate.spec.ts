import { X509Certificate } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface WeriftCertificateSurface {
  createSelfSignedCertificate(
    signatureHash: { signature: number; hash: number },
    namedCurve: number,
  ): Promise<{ certPem: string; keyPem: string }>
  SignatureAlgorithm: { ecdsa_3: number }
  HashAlgorithm: { sha256_4: number }
  NamedCurveAlgorithm: { secp256r1_23: number }
}

/**
 * Loads the werift build that ring-client-api itself imports: werift is a
 * transitive dependency, so it resolves from ring-client-api's real package
 * directory through werift's ESM `import` export.
 */
async function loadRingWerift(): Promise<WeriftCertificateSurface> {
  const ringPackage = realpathSync(findPackageJSON('ring-client-api', import.meta.url)!)
  const weriftPackage = findPackageJSON('werift', pathToFileURL(ringPackage))!
  const manifest = JSON.parse(readFileSync(weriftPackage, 'utf8')) as { exports: { '.': { import: string } } }
  return await import(pathToFileURL(join(dirname(weriftPackage), manifest.exports['.'].import)).href) as WeriftCertificateSurface
}

describe('Ring live-stream DTLS certificate', () => {
  it('creates the self-signed certificate werift offers before every Ring WebRTC stream', async () => {
    const werift = await loadRingWerift()
    const { certPem, keyPem } = await werift.createSelfSignedCertificate(
      { signature: werift.SignatureAlgorithm.ecdsa_3, hash: werift.HashAlgorithm.sha256_4 },
      werift.NamedCurveAlgorithm.secp256r1_23,
    )
    const certificate = new X509Certificate(certPem)
    expect(certificate.subject).toContain('O=Internet Widgits Pty Ltd')
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
  })
})
