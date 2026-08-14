# ADR 0007: Durable snapshot SSE delivery

- Status: Accepted
- Date: 2026-08-13

## Context

EVT-01 requires live completed-snapshot delivery across multiple web instances, bounded replay, authorization,
and explicit slow-consumer behavior. Process-local emitters or PostgreSQL notifications alone cannot recover
events after disconnect and cannot prove gap-free resume.

## Decision

Public metric finalization appends one validated `snapshot_events` record in the same transaction as its
reconciliation snapshot. A monotonic database ID is the SSE cursor. Web instances poll this shared append-only
log, replay strictly after `Last-Event-ID`, and refuse a resume that exceeds the configured bound. PostgreSQL
`LISTEN/NOTIFY` is not the source of truth and may be added later only as a wake-up optimization.

Events contain a public REST pointer and summary, not the complete snapshot or raw evidence. Anchor reserve
comparison snapshots are excluded because their publication gate is represented by a separate read model.
Connections without a cursor begin at the current tail.

Hosted streams require `events:read`, consume the `events.snapshots` quota when opened, and periodically repeat
authorization and quota consumption. Heartbeats do not advance the event ID. Backpressured consumers are closed
after a bounded number of polls; overflow produces a terminal replay error rather than silently skipping IDs.

## Consequences

All replicas observe one ordered replay log, and reconnecting clients can prove continuity within the bound.
Polling adds bounded database reads even while idle, while recurring access checks consume explicit stream quota.
Clients that fall behind must refresh canonical REST resources before starting again at the live tail.
