# Credential rotation

Rotate database, API, relay, webhook/contact-encryption, backup, deployment, and monitoring credentials at least
every 90 days and immediately after suspected exposure or operator departure. Use overlap where supported:

1. Create a new least-privilege credential and record its owner and expiry in the secret manager.
2. Deploy consumers with both old and new verification material where applicable; verify readiness and one real
   operation with the new credential.
3. Switch issuance/writes to the new credential, then revoke the old credential.
4. Confirm the old credential fails, inspect authentication failures, and record the audit event.

API keys rotate transactionally with `npm run api:key-rotate -- --prefix ...`. Anchor contact secrets rotate by
adding the new `ANCHOR_CONTACT_SECRET_KEYS` key ID, making it active, running
`anchor:rotate-contact-secret` for every endpoint, verifying no row references the old key, and only then removing
the prior key. Database rotation uses a new role/password, rolling web and worker restart, pool drain, and old-role
revocation. Never print, pass on a command line, or commit plaintext credentials; use stdin or managed injection.

Rotate the active `DATABASE_BACKUP_ENCRYPTION_KEYS` entry by retaining the old version until every retained backup encrypted with it
expires or is re-encrypted and restore-tested. Run `ops:backup`, `ops:backup-check`, and one isolated restore drill
with the new key before retiring the old key. Rotate `AXIOM_SITE_API_KEY` through the same transactional API-key
flow before updating the managed site secret. Relay, database, backup, monitoring, and deployment credentials must
each have an owner-specific verification and explicit old-credential rejection recorded in the rotation ticket.
