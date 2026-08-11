import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/site'
import {
  ReconciliationDashboard,
  ReconciliationDashboardLoading,
} from '@/components/dashboard/reconciliation-dashboard'

export const metadata: Metadata = {
  title: 'Reconciliation dashboard',
  description: 'Inspect the latest persisted Stellar supply reconciliation with source, time, confidence, and discrepancy context.',
}

export default function DashboardPage() {
  return (
    <main>
      <PageHero
        docCode="AL-DATA-01 · LIVE SNAPSHOT"
        kicker="Reconciliation dashboard"
        title="One value, with the evidence left attached."
      >
        Inspect the latest finalized on-chain supply snapshot, its confidence components, source
        contributions, failures, and publication-approved discrepancies.
      </PageHero>
      <Suspense fallback={<ReconciliationDashboardLoading />}>
        <ReconciliationDashboard />
      </Suspense>
    </main>
  )
}
