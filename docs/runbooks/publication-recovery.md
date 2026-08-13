# Notification failure and public correction

## Notification failure

Use the durable notification and delivery-attempt records to identify channel, attempt count, retryability, and
failure code without exposing contact secrets. Confirm relay/webhook health and credential validity. Retryable
failures follow bounded backoff; do not manually mark a notification sent. After maximum attempts, keep the case
internal, repair the transport/contact, then have an active `anchor:review` principal run
`printf '%s' 'incident reference and verified repair' | npm run anchor:requeue-notification -- --notification ID --administrator PRINCIPAL_ID`. The command accepts only
terminal, failed, unleased notifications and appends a `notice_requeued` case event. The reply clock starts
only from a durably recorded successful delivery. Verify one success event and no duplicate notice before closing.

## Incorrect public result or named-party publication

Set `ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED=false` and roll the web/worker deployment first while preserving internal ingestion. Capture the public payload,
request/cycle IDs, snapshot, methodology, approval events, and discovery time. Never overwrite the original
snapshot, discrepancy, reply, review, or claim. Use `anchor:review-case -- --decision withhold` where the case is
still reviewable, or pipe the reason into `anchor:correct-flag -- --action corrected|retracted ...` to append a linked
correction or retraction, obtain the required approval, and verify the public endpoint exposes only approved state.
Notify affected parties through the case workflow when required. Re-enable publication after API, SSE, cache, and
status verification, then document scope, duration, recipients, and corrective action.
