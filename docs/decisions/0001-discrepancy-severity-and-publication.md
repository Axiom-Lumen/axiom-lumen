# ADR 0001: Separate discrepancy severity from publication state

- Status: accepted for implementation
- Date: 2026-08-09
- Methodology impact: v1.3 → v1.4
- Owners: engineering; product/legal review required before named-party publication is enabled

## Context

The v1.3 agent guide, public severity table, and anchor procedure described incompatible triggers.
They also coupled three different questions:

1. How far does an observation deviate from the reference value?
2. How long has that deviation persisted?
3. May a discrepancy involving a named party be published?

Using one severity label for all three makes deterministic reconciliation difficult and could publish
anchor-facing claims before the right-of-reply process is complete.

## Decision

Version 1.4 models measurement severity, lifecycle, and publication state separately.

### Measurement severity

Let `d` be absolute deviation and `T` be the configured tolerance for the metric.

| Result | Mechanical rule |
|---|---|
| Within tolerance | `d <= T`; no discrepancy is opened |
| Info | `T < d <= 2T` |
| Warning | `d > 2T` for one or two consecutive completed refresh cycles |
| Critical | `d > 2T` for three or more consecutive completed refresh cycles |

Boundaries are inclusive on the lower-severity side: exactly `T` is within tolerance and exactly `2T`
is Info. A stale, missing, malformed, excluded, or unreachable source is a source-health outcome, not a
numeric discrepancy.

### Lifecycle state

The initial lifecycle states are `open` and `resolved`. A discrepancy opens on its first out-of-tolerance
completed cycle. It remains open while deviation exceeds `T`. A later completed cycle at or within `T`
appends a resolution event and resets the consecutive-cycle count for any future occurrence.

Finalized cycles are ordered by their cycle timestamp. Late or duplicate observations cannot rewrite the
persistence count of an already-finalized cycle. Corrections and retractions are append-only events; the
original observation and classification remain in the audit history.

### Publication state

Publication uses a separate state machine:

| State | Meaning |
|---|---|
| `internal` | Stored for audit; not available on public surfaces |
| `pending_reply` | A named affected party has been notified and the 72-hour reply/review process is active |
| `approved_public` | A human reviewer approved publication after the response was reviewed or the window expired |
| `withheld` | A reviewer prevented publication because evidence, attribution, or process requirements were not met |

Info discrepancies remain `internal`. A Warning or Critical discrepancy involving a named anchor or issuer
enters `pending_reply`; it cannot become public automatically. The 72-hour window does not change Warning
to Critical. Severity changes only through measured deviation and consecutive completed cycles.

A Warning or Critical infrastructure discrepancy with no named affected party may be eligible for public
display under a later automated policy, but v1 defaults to human review for all public discrepancy output.

### Transition summary

```text
d <= T
  no open discrepancy, or open → resolved

T < d <= 2T
  open/info/internal

d > 2T, cycle 1–2
  open/warning/internal or pending_reply

d > 2T, cycle 3+
  open/critical/internal or pending_reply

pending_reply + reviewed response or expired window + reviewer approval
  → approved_public
```

## Worked examples

- With a 1-ledger tolerance, a source at reference `+1` is within tolerance, `+2` is Info, and `+3`
  is Warning on cycles one and two and Critical on cycle three if the deviation persists.
- A source that times out for three cycles is unhealthy, not Critical. There is no comparable numeric
  observation to classify.
- A named anchor can reach Critical during its reply window, but its publication state remains
  `pending_reply` until human approval.
- A Warning still open after 72 hours remains Warning if it has only two completed observations. The elapsed
  reply window affects publication eligibility, not measurement severity.

## Consequences

- The public methodology version becomes v1.4.
- Reconciliation can classify measurements without embedding notification or legal-review policy.
- Persistent storage must retain prior cycle state and append all transitions.
- API and dashboard code must filter by publication state before exposing named-party discrepancies.
- The future right-of-reply workflow needs explicit human approval and fail-closed behavior.

## Out of scope

- Metric-specific tolerance values other than implemented metric profiles.
- Notification transport and reviewer user interface.
- A decision that any named anchor or issuer has acted improperly.
