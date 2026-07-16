# Production job signing

External `.lwjob.json` imports require a detached ECDSA P-256 signature. Same-origin jobs loaded through `/production/jobs/index.json` continue to use the index digest and raw-body hash path; they do not require a detached signature.

## Signing

The protected private key lives outside the repository at:

```text
~/.config/lightweaver/production-job-signing-key.pem
```

Its parent directory must be mode `0700` and the key must be mode `0600`. The builder refuses a key readable by group or others. Never commit, print, log, or attach this file.

Pass the key explicitly or through the environment:

```bash
node scripts/build-production-job.mjs \
  --input release/job-source.json \
  --public-root lightweaver/public \
  --signing-key ~/.config/lightweaver/production-job-signing-key.pem

LIGHTWEAVER_PRODUCTION_JOB_SIGNING_KEY=~/.config/lightweaver/production-job-signing-key.pem \
  node scripts/build-production-job.mjs \
  --input release/job-source.json \
  --public-root lightweaver/public
```

The builder writes `<digest>.lwjob.sig.json` beside the immutable artifact. The envelope contains only `keyId`, `algorithm`, and the base64url signature over the exact artifact bytes with the documented domain prefix.

## Rotation and revocation

`PRODUCTION_JOB_TRUST_SET` is the only external-import trust interface. Each entry binds a `keyId`, algorithm, and public key. `PRODUCTION_JOB_ACTIVE_SIGNING_KEY_ID` selects the builder's default signing identity.

For rotation:

1. Generate the replacement private key outside the repository with the same protected permissions.
2. Add only its public key under a new immutable key ID, retain the prior public key during the overlap, and update the active signing key ID.
3. Increment `PRODUCTION_JOB_TRUST_SET_VERSION` whenever the published trust membership changes.
4. Re-sign artifacts that must remain externally importable, deploy readers containing the new trust set, then remove the retired public key in a later version.

For emergency revocation, remove the compromised public key, increment the trust-set version, deploy immediately, and re-sign permitted artifacts with a non-revoked key. Unknown and removed key IDs fail closed. Old clients retain the trust set compiled into their build, so revocation requires shipping the updated reader.
