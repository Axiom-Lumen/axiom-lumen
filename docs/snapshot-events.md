# Snapshot server-sent events

`GET /api/v1/events/snapshots` streams durable notifications for completed latest-ledger, supply, depth, and
trustline snapshots. Anchor reserve comparison snapshots are excluded because their named-party publication
state requires a separate reviewed disclosure projection.

Hosted connections require an `X-Axiom-Key` principal with `events:read`. Opening a stream consumes the
`events.snapshots` route quota. The server reauthorizes at a bounded interval and consumes another stream quota
unit, so revocation, scope removal, plan disabling, and quota exhaustion close existing connections promptly.
Anonymous local mode neither authenticates nor consumes quota.

```bash
curl -N \
  -H "X-Axiom-Key: $AXIOM_KEY" \
  -H "Last-Event-ID: 42" \
  http://localhost:3000/api/v1/events/snapshots
```

Native browser `EventSource` cannot attach the required API-key header. Hosted browser clients must use a
header-capable fetch-streaming client or a reviewed same-origin server proxy. Keys are never accepted in query
parameters.

## Delivery and resume

Each completed public snapshot appends one `snapshot_events` row in the same transaction as the snapshot. Its
monotonic PostgreSQL ID becomes the SSE `id`; all application replicas poll the same durable log. Event data is
a validated public pointer containing the snapshot ID, metric, subject, status, time, methodology version, and
canonical REST resource. It never contains raw evidence or internal named-party discrepancies.

Clients must persist an ID only after fully processing its event. Reconnect using `Last-Event-ID`; replay starts
strictly after that ID. Omitting the header starts at the current tail rather than replaying history. Invalid or
future IDs return `400`. Missing cursors or more pending records than `EVT_SSE_REPLAY_LIMIT` return `409`; clients
must refresh current REST resources and reconnect without a cursor.

Heartbeat comments keep idle connections visible without advancing the cursor. The server never drops an event
silently: falling outside the replay bound emits a terminal error and closes. A consumer that leaves the response
queue backpressured for `EVT_SSE_MAX_BACKPRESSURE_POLLS` is closed instead of accumulating unbounded memory.

Configuration defaults are documented in `.env.example`. Deployment proxies must disable response buffering,
permit long-lived responses for at least the route's `maxDuration`, and preserve `Last-Event-ID` on reconnect.
