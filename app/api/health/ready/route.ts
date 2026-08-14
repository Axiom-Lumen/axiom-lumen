import { checkOperationalReadiness } from '../../../../lib/db/operational-status'
import { errorTelemetry, resolveTraceContext, structuredLog } from '../../../../lib/observability/telemetry'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const startedAt = Date.now()
  const trace = resolveTraceContext(request.headers.get('traceparent'))
  try {
    await checkOperationalReadiness()
    structuredLog('info', 'health_probe_completed', {
      trace_id: trace.traceId, span_id: trace.spanId, probe: 'readiness', status_code: 200,
      duration_ms: Date.now() - startedAt,
    })
    return Response.json({ status: 'ready', checked_at: new Date().toISOString() }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store', Traceparent: trace.traceparent, 'X-Content-Type-Options': 'nosniff' },
    })
  } catch (error) {
    structuredLog('error', 'health_probe_completed', {
      trace_id: trace.traceId, span_id: trace.spanId, probe: 'readiness', status_code: 503,
      duration_ms: Date.now() - startedAt, ...errorTelemetry(error),
    })
    return Response.json({ status: 'not_ready', checked_at: new Date().toISOString() }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', Traceparent: trace.traceparent, 'X-Content-Type-Options': 'nosniff' },
    })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS', 'Cache-Control': 'no-store' } })
}
