import { loadPublicOperationalStatus } from '../../../lib/db/operational-status'
import { renderOperationalMetrics } from '../../../lib/observability/metrics'
import { errorTelemetry, structuredLog } from '../../../lib/observability/telemetry'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const status = await loadPublicOperationalStatus()
    return new Response(renderOperationalMetrics(status), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    structuredLog('error', 'operational_metrics_failed', errorTelemetry(error))
    return new Response('# telemetry unavailable\n', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS', 'Cache-Control': 'no-store' } })
}
