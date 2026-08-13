import { z } from 'zod'

const policyIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/)

export const PUBLIC_API_ACCESS_POLICIES = {
  latestLedger: { routeId: 'stellar.latest-ledger', requiredScope: 'metrics:read' },
  supply: { routeId: 'stellar.supply', requiredScope: 'metrics:read' },
  depth: { routeId: 'stellar.depth', requiredScope: 'metrics:read' },
  trustlines: { routeId: 'stellar.trustlines', requiredScope: 'metrics:read' },
  anchorReserves: { routeId: 'anchors.reserves', requiredScope: 'anchors:read' },
  snapshotEvents: { routeId: 'events.snapshots', requiredScope: 'events:read' },
} as const

export interface PublicApiAccessPolicy {
  routeId: string
  requiredScope: string
}

export function parsePublicApiAccessPolicy(policy: PublicApiAccessPolicy) {
  return {
    routeId: policyIdentifierSchema.parse(policy.routeId),
    requiredScope: policyIdentifierSchema.parse(policy.requiredScope),
  }
}
