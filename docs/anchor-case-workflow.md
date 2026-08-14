# Anchor case workflow

> Implementation status: ANC-03 complete. The workflow remains internal; the public endpoint reads only its
> explicitly publication-approved output.

The case workflow consumes an open, named-party Warning or Critical discrepancy that is attributed to a
currently verified anchor. It creates one deterministic case and one initial notification record for each
verified email or webhook contact. Reprocessing the same discrepancy returns the existing case and cannot
enqueue a second initial notice for the same contact.

## Fail-closed sequence

1. A case opens in `draft`; its `reply_due_at` is null and the discrepancy stays `internal`.
2. Each transport attempt is appended to `notification_delivery_attempts`. Stored failure metadata is
   structured and transport response bodies are represented only by a SHA-256 digest.
3. A failed attempt leaves the case in `draft` and cannot change publication state.
4. The first successful delivery atomically moves the case to `awaiting_reply`, sets the deadline to 72 hours
   after delivery, and changes the discrepancy to `pending_reply` / `awaiting_reply`.
5. Additional contacts may receive the same notice, but they do not restart or extend the reply window.
6. Publication still requires a reviewed response or an expired window and an explicit human approval under
   [ADR 0001](./decisions/0001-discrepancy-severity-and-publication.md).

Case events and delivery attempts are append-only. `anchor_cases`, `notifications`, and `discrepancies` are
current-state projections; their immutable histories are the case, delivery, and discrepancy event tables.

## Internal review data

The internal repository exposes a review queue and a case-evidence read that includes methodology version,
measurement timestamps, prior discrepancy events, case events, and redacted persisted raw evidence. These are
not public API contracts and must remain behind reviewer authorization when a review surface is added.

## Operations

Set `ANCHOR_WORKFLOW_ENABLED=true` only after verified contacts and the relevant transport are configured. Email
delivery uses the configured HTTPS relay. Webhook requests use `X-Axiom-Lumen-Delivery`,
`X-Axiom-Lumen-Timestamp`, and an HMAC-SHA256 `X-Axiom-Lumen-Signature` in `v1=<hex>` form. Both transports
use bounded, SSRF-protected HTTPS requests.

Webhook secrets use AES-256-GCM with contact/version-bound authenticated data. Rotate them without placing the
secret in shell arguments:

```bash
printf '%s' "$WEBHOOK_SECRET" | npm run anchor:rotate-contact-secret -- --contact '<contact-id>'
```

Reviewer principals must be active and hold the `anchor:review` scope. Review commands append immutable review,
case, and discrepancy events:

```bash
npm run anchor:review-case -- --case '<case-id>' --reviewer '<principal-id>' --decision withhold
```

Approval is fail-closed unless `ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED=true`. That variable must remain false
until the product/legal approval required by ADR 0001 is recorded. The public reserve route cannot enable or
advance publication; it only serves material that has already completed this approval path.

Notification workers use PostgreSQL leases with fencing tokens, exponential retry delays, bounded concurrency,
and deterministic idempotency keys. Expired leases are reclaimable; stale workers cannot record delivery.
