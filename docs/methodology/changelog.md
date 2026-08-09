# Methodology changelog

The public methodology is versioned independently from application releases. Changes to weights, freshness
parameters, tolerance bands, confidence formulas, or severity thresholds require a new methodology version.

## v1.4 — 2026-08-09

- Separated measurement severity, discrepancy lifecycle, and publication state.
- Defined exact tolerance boundaries: values at or within tolerance are not discrepancies; Info is above
  tolerance through `2 × tolerance`; Warning is above `2 × tolerance` for one or two completed cycles; and
  Critical is above `2 × tolerance` for at least three completed cycles.
- Classified stale, missing, malformed, excluded, and unreachable sources as source-health outcomes rather
  than numeric discrepancies.
- Made named-party publication fail closed until the right-of-reply process and human approval complete.
- Clarified that expiry of the 72-hour reply window affects publication review, not measurement severity.
- Added executable, runtime-validated configuration for source-class weights and the implemented
  latest-ledger v0.1 profile.

Decision record: [`0001-discrepancy-severity-and-publication.md`](../decisions/0001-discrepancy-severity-and-publication.md)

## v1.3 — baseline

- Defined five source classes and their base weights.
- Specified exponential freshness decay and weighted-median reconciliation.
- Required confidence and source context on metric output.
- Established permanent discrepancy retention and a 72-hour right-of-reply window.

The v1.3 severity wording was internally inconsistent across project documents. Version 1.4 supersedes it.

## Version-bump procedure

1. Add a new immutable config module rather than editing an already-released version in place.
2. Update the exported current version and add a dated changelog entry.
3. Add or update golden methodology fixtures and configuration validation tests.
4. Synchronize the agent guide, public methodology, anchor procedure, API examples, and footer.
5. Document migrations or API compatibility consequences in an ADR when persisted output changes.
