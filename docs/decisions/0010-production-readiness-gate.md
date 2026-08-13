# ADR 0010: Production-readiness gate before public v1

- Status: accepted
- Date: 2026-08-13
- Methodology impact: none
- Owners: engineering implements the gate; product, legal, and operations own remaining sign-offs

## Context

REL-01 can promote an immutable artifact. That is not the same as declaring a public v1. The remaining risks are
operational ownership, independent review, and public copy that overstates billed or unpublished capabilities.

## Decision

Public v1 is a separately signed declaration, not a git tag or a successful promotion. The committed
[`production-readiness.record.json`](../releases/production-readiness.record.json) is the executable record.

1. The record cannot set `public_v1_declared` to `true` while any required sign-off is `unsigned`.
2. Required sign-offs are restore drill, incident exercise, independent security review, independent methodology
   fixture review, product/legal publication review, public-claims review, and named SLO/on-call/rollback owners.
3. Named-party publication remains independently disabled until the publication legal sign-off is accepted.
4. Every documented public GET operation must be exercised by release smoke, including snapshot SSE and the
   public status page. Planned, paid, or live labels are forbidden unless that capability is in the smoke set.
5. Commercial SLAs, self-service checkout, and billed plan prices are not public claims until billing and
   ownership exist end to end.

Engineering may accept the public-claims sign-off after an audit. The other sign-offs are operator or independent
reviewer actions and stay unsigned in this repository until recorded with reviewer, UTC timestamp, and evidence.

## Consequences

Promotion can continue into isolated environments. Marketing, README, pricing, and OpenAPI cannot describe a
generally available public v1 while the record is unsigned. Residual security findings in the threat model remain
accepted only as documented engineering mitigations, not as a completed independent review.
