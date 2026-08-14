import { loadConfidenceArtifact, resolveConfidenceAsset } from '../../../lib/home/confidence-artifact'
import { loadFirstPartyConfidenceArtifact } from '../../../lib/home/site-confidence-artifact'
import { ReconciliationStripView } from './reconciliation-strip-view'

export async function ReconciliationStrip({
  load = loadConfidenceArtifact,
}: {
  load?: typeof loadConfidenceArtifact
} = {}) {
  const { state, refreshEnabled } = await loadFirstPartyConfidenceArtifact(load)
  const asset = resolveConfidenceAsset(state.asset)

  return (
    <ReconciliationStripView
      initialState={state}
      endpoint={`/api/v1/supply/${encodeURIComponent(asset)}`}
      refreshEnabled={refreshEnabled}
    />
  )
}
