# `config/`

Build-time configuration that ships with the FORGE binary / container.

## `license-pubkey.pem`

Ed25519 public key used to verify FORGE license tokens (see
`docs/LICENSING.md`). Replace with **your** vendor public key before
distributing a fork; the bundled key is FORGE's own development key
and any signed license verifying against it is for testing only.

To rotate:

```bash
# 1. Generate a new keypair (writes pubkey + privkey PEMs)
node scripts/license/keygen.js > my-vendor-keys.txt

# 2. Replace this file with the public half
sed -n '/BEGIN PUBLIC/,/END PUBLIC/p' my-vendor-keys.txt \
  > config/license-pubkey.pem

# 3. Store the private half in your vendor secrets manager
# 4. Rebuild and redistribute
npm run build
```

Self-hosted customers can override the bundled key by setting
`FORGE_LICENSE_PUBLIC_KEY` to either a PEM blob or a base64url of the
raw 32-byte Ed25519 public key.
