# Stateful discrepancy classification

`lib/reconcile/discrepancy-state.ts` implements methodology v1.5's append-only discrepancy state machine.
Measurement severity, lifecycle, and publication state are independent dimensions; no elapsed time or review
action can change measurement severity.

## Measurement and lifecycle

For absolute deviation `d` and tolerance `T`:

| Condition | Severity |
|---|---|
| `d <= T` | No discrepancy, or resolution of an open discrepancy |
| `T < d <= 2T` | Info |
| `d > 2T`, first or second consecutive cycle | Warning |
| `d > 2T`, third or later consecutive cycle | Critical |

The state stores both total consecutive out-of-tolerance cycles and consecutive cycles above the Info band.
An Info observation keeps the discrepancy open but resets only the above-Info streak. This prevents a later
large deviation from inheriting unrelated Info persistence and becoming Critical too early.

The state machine consumes the resulting deviation band rather than a JavaScript numeric amount. Boundary
helpers are provided for safe-integer metrics such as ledger sequences and for decimal-safe `StellarAmount`
values. This preserves exact seven-decimal amount boundaries and values beyond JavaScript's safe integer range.

Only strictly newer completed cycles advance state. A duplicate cycle ID or a cycle timestamp at or before the
last finalized cycle returns no events and cannot reduce persistence. Opening, observation, escalation,
reconvergence, and resolution produce deterministic appendable events. Reconvergence emits both a measured
`reconverged` fact and a `resolved` lifecycle fact; neither removes the earlier history. A later recurrence opens
a new discrepancy occurrence. State and events retain the source and methodology version needed for replay.

Corrections and retractions append amendment events that identify the original event and require deterministic
replay. They never edit or delete the original event in place.

## Publication

Info records remain internal. A named-party Warning or Critical record remains internal until successful
notification is durably recorded, then enters `pending_reply` with an
`awaiting_reply` review state. Publication requires a non-empty human reviewer ID and either:

- a received response that a reviewer has marked reviewed; or
- an unanswered reply window that has mechanically reached the configured duration (72 hours in v1.5).

The action sequence and every state change are appendable publication events. A named-party record cannot move
directly from `pending_reply` to `approved_public`, and expiry never changes Warning to Critical. Withholding is
also an explicit reviewed action. If an approved, still-open Warning or Critical measurement drops into the Info
band, its current projection returns to `internal`; the earlier approval remains in the append-only event history.
Notification delivery and reviewer UI remain later workflow work.

## Persistence boundary

Persisted state is parsed through the shared runtime schema before every measurement, amendment, or publication
transition. The schema rejects invalid timestamps, persistence counters, severity/streak combinations, and
publication/reply combinations. Measurement event IDs use length-prefixed identifiers so permitted `:`
characters cannot create ambiguous IDs. Amendments require the complete target event and verify matching
discrepancy, source, methodology, and chronology; durable storage must additionally enforce event-ID uniqueness
and target foreign keys when REC-04 connects a repository.
