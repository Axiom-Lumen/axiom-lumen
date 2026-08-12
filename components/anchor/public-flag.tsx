import type { PublicAnchorFlag } from '../../lib/db/anchor-public-read-model'

function publicEvidenceUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

/** Renders claimant-authored text as text nodes only. Never introduce raw HTML here. */
export function PublicAnchorFlagView({ flag }: { flag: PublicAnchorFlag }) {
  return (
    <article aria-labelledby={`anchor-flag-${flag.flagId}`}>
      <h2 id={`anchor-flag-${flag.flagId}`}>{flag.anchor} discrepancy</h2>
      <p>Severity: {flag.severity}</p>
      <p>Methodology: {flag.methodologyVersion}</p>

      {flag.corrections.length > 0 && (
        <section aria-label="Corrections and retractions" role="status">
          <h3>Corrections and retractions</h3>
          {flag.corrections.map((correction) => (
            <article key={correction.id}>
              <strong>{correction.type === 'retracted' ? 'Retracted' : 'Corrected'}</strong>
              <p>{correction.reason}</p>
              {correction.replacement && typeof correction.replacement.correctedDeviationBand === 'string' && (
                <p>Corrected deviation: {correction.replacement.correctedDeviationBand}</p>
              )}
              <time dateTime={correction.occurredAt}>{correction.occurredAt}</time>
            </article>
          ))}
        </section>
      )}

      {flag.response && (
        <section aria-label="Anchor response">
          <h3>Anchor response</h3>
          <p>{flag.response.body}</p>
          <p>Version {flag.response.version}</p>
          <time dateTime={flag.response.submittedAt}>{flag.response.submittedAt}</time>
          {flag.response.evidence.length > 0 && (
            <ul>
              {flag.response.evidence.map((item) => (
                <li key={item.id}>
                  {item.kind === 'link'
                    ? (publicEvidenceUrl(item.url)
                      ? <a href={publicEvidenceUrl(item.url)!} target="_blank" rel="noreferrer">Evidence link</a>
                      : 'Unavailable evidence link')
                    : `Scanned ${item.contentType} evidence (${item.byteSize} bytes, SHA-256 ${item.sha256})`}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {flag.disputes.map((dispute) => (
        <section aria-label="Resolved dispute" key={dispute.id}>
          <h3>Dispute: {dispute.status}</h3>
          <p>{dispute.body}</p>
        </section>
      ))}
    </article>
  )
}
