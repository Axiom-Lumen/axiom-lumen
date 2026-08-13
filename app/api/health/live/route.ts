import { resolveTraceContext, structuredLog } from '../../../../lib/observability/telemetry'
import { parseReleaseFeatureFlags, parseReleaseMetadata } from '../../../../lib/release/config'

export const dynamic = 'force-dynamic'

function response(request: Request, status: number, body: unknown) {
  const trace = resolveTraceContext(request.headers.get('traceparent'))
  structuredLog(status >= 500 ? 'error' : 'info', 'health_probe_completed', {
    trace_id: trace.traceId, span_id: trace.spanId, probe: 'liveness', status_code: status,
  })
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Traceparent: trace.traceparent, 'X-Content-Type-Options': 'nosniff' },
  })
}

export function GET(request: Request) {
  return response(request, 200, {
    status: 'alive',
    checked_at: new Date().toISOString(),
    release: parseReleaseMetadata(),
    features: parseReleaseFeatureFlags(),
  })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS', 'Cache-Control': 'no-store' } })
}

export function POST(request: Request) {
  const result = response(request, 405, { status: 'method_not_allowed' })
  result.headers.set('Allow', 'GET, OPTIONS')
  return result
}
