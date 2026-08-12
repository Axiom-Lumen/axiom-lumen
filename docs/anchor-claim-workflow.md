# Anchor claims, replies, disputes, and corrections

ANC-04 provides an internal operator workflow. It does not enable a public reserve route, web form, or claimant
API. Named-party material remains fail-closed behind the existing product/legal publication gate.

## Domain claim

Issue a 30-minute challenge for a currently verified anchor:

```bash
npm run anchor:request-claim -- --anchor '<anchor-id>'
```

The claimant adds the one-time value to `https://<verified-domain>/.well-known/stellar.toml`:

```toml
[[VERIFICATION]]
provider = "axiomlumen.io"
claim_token = "al_claim_..."
```

Verify it without placing the bearer value in process arguments:

```bash
ANCHOR_CLAIM_TOKEN='<one-time-token>' npm run anchor:verify-claim -- --challenge '<challenge-id>'
```

The challenge and session tokens are stored only as SHA-256 hashes. A challenge is scoped to its anchor/domain,
expires, and is atomically consumed. The returned session token is displayed once, expires within 24 hours (and
never after domain verification), and can be revoked. Keep it in a secret manager.

Register a monitored email or webhook on the proven domain:

```bash
ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:register-contact -- \
  --kind email --endpoint 'ops@anchor.example'
```

Webhook registration performs a same-domain challenge and atomically installs an encrypted signing secret:

```bash
ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' ANCHOR_WEBHOOK_SECRET='<signing-secret>' \
  npm run anchor:register-contact -- --kind webhook --endpoint 'https://anchor.example/hooks/axiom'
```

`ANCHOR_CONTACT_SECRET_KEYS` and `ANCHOR_CONTACT_ACTIVE_KEY_ID` must also be configured. The webhook must respond
to the bounded JSON challenge request with the same `{ "challenge": "..." }` value. Contacts expire with the
claim verification and are excluded after revocation:

```bash
ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:revoke-contact -- --contact '<contact-id>'
ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:revoke-session
```

## Replies and disputes

Reply bodies are read from standard input; repeat `--link` for public HTTPS evidence references:

```bash
printf '%s' 'Measured explanation' | \
  ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:submit-reply -- \
  --case '<case-id>' --link 'https://anchor.example/evidence.pdf'
```

Repeat `--upload` for `.pdf`, `.jpg`, `.jpeg`, `.png`, or `.txt` evidence files. Uploads require a locally managed
ClamAV executable and `ANCHOR_EVIDENCE_STORAGE_DIRECTORY`; bytes are scanned before content-addressed storage:

```bash
printf '%s' 'Measured explanation' | \
  ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:submit-reply -- \
  --case '<case-id>' --upload './evidence.pdf'
```

```bash
printf '%s' 'Reason this published flag should be reviewed' | \
  ANCHOR_CLAIM_SESSION_TOKEN='<session-token>' npm run anchor:submit-dispute -- \
  --flag '<flag-id>'
```

Replies are append-only versions linked to the prior version. Links are public-HTTPS validated and are never
fetched during rendering. Upload integration accepts PDF, JPEG, PNG, or text up to 5 MB, invokes malware scanning
before storage, and persists only clean-object metadata and an opaque storage reference. PostgreSQL rejects
updates or deletes to reply and evidence records.

## Review and correction

Dispute resolution requires an active principal with `anchor:review`. Corrections and retractions require
`anchor:correct` and target an immutable discrepancy event:

```bash
npm run anchor:review-disputes -- --principal '<principal-id>'
npm run anchor:review-disputes -- --principal '<principal-id>' --dispute '<dispute-id>'
npm run anchor:resolve-dispute -- --principal '<principal-id>' --dispute '<dispute-id>' --decision resolved
```

Disputes remain internal by default. `--publish` additionally requires
`ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED=true` and records the explicit publication decision.

```bash
printf '%s' 'Non-comparable source period' | npm run anchor:correct-flag -- \
  --case '<case-id>' --event '<event-id>' --principal '<principal-id>' --action retracted
```

A correction supplies its replacement deviation band:

```bash
printf '%s' 'Corrected comparison classification' | npm run anchor:correct-flag -- \
  --case '<case-id>' --event '<event-id>' --principal '<principal-id>' --action corrected \
  --corrected-deviation-band info
```

The public read model selects only publication-approved responses and disputes, clean evidence
metadata, and append-only corrections. It never selects claim/session tokens, claimant identity, reviewer notes,
upload storage references, or rejected/unscanned evidence. The React view renders claimant text as escaped text
nodes, independently rejects unsafe link schemes, and places corrections before the response they amend. A
correction is exposed only when its flag has a prior approved publication.
