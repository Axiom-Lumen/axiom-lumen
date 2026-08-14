import { loadConfidenceArtifact, resolveConfidenceAsset } from '../../lib/home/confidence-artifact'
import { loadFirstPartyConfidenceArtifact } from '../../lib/home/site-confidence-artifact'
import { ReconciliationDashboardView } from './reconciliation-dashboard-view'

export function ReconciliationDashboardLoading() {
  return (
    <section aria-labelledby="dashboard-loading-title" className="border-t border-linesoft">
      <div className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10 sm:py-20">
        <h2 id="dashboard-loading-title" className="font-serif text-2xl text-ink">
          Loading current reconciliation…
        </h2>
        <p role="status" aria-live="polite" className="mt-3 font-mono text-xs text-dim">
          Requesting and validating the latest finalized API snapshot.
        </p>
        <div aria-hidden="true" className="mt-10 grid animate-pulse gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-20 border-t border-linesoft" />)}
        </div>
      </div>
    </section>
  )
}

export async function ReconciliationDashboard({
  load = loadConfidenceArtifact,
}: {
  load?: typeof loadConfidenceArtifact
} = {}) {
  const { state, refreshEnabled } = await loadFirstPartyConfidenceArtifact(load)
  const asset = resolveConfidenceAsset(state.asset)
  return (
    <ReconciliationDashboardView
      initialState={state}
      endpoint={`/api/v1/supply/${encodeURIComponent(asset)}`}
      refreshEnabled={refreshEnabled}
    />
  )
}
