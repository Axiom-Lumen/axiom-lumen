import type { ReleaseFeatureFlags } from '../release/config'
import { parseReleaseFeatureFlags } from '../release/config'
import { apiErrorResponse } from './api'

export type MetricFeature = Exclude<keyof ReleaseFeatureFlags, 'namedPartyPublication'>

export function metricFeatureEnabled(feature: MetricFeature) {
  return parseReleaseFeatureFlags()[feature]
}

export function featureDisabledResponse(request: Request, requestId: string, asOf: Date) {
  return apiErrorResponse({
    request,
    status: 404,
    code: 'feature_not_available',
    message: 'This capability is not available in the current environment',
    requestId,
    asOf,
  })
}
