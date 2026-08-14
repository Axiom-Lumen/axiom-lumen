import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fetchMzarReserveObservation, parseMzarReserveReport } from '../../lib/stellar/mzar-reserve'
import { anchorReserveConnectorProfile, MZAR_ISSUER } from '../../lib/stellar/mzar-profile'

const reportText = readFileSync(new URL('../fixtures/stellar/mzar-attestation-2026-02.extracted.txt', import.meta.url), 'utf8')
const indexText = readFileSync(new URL('../fixtures/stellar/mzar-attestation-index-2026-04.redacted.html', import.meta.url), 'utf8')
const asset = { kind: 'credit' as const, code: 'mZAR', issuer: MZAR_ISSUER }
const source = {
  id: 'mesh_mzar',
  url: 'https://mzar.co.za/',
  sourceClass: 'anchor_self_reported' as const,
  adapter: 'anchor' as const,
  network: { id: 'public' as const, passphrase: 'Public Global Stellar Network ; September 2015' },
}

function connector() {
  return vi.fn(async (target: { url: URL }) => {
    if (target.url.toString() === source.url) return new Response(indexText, { headers: { 'content-type': 'text/html; charset=UTF-8' } })
    if (target.url.pathname.endsWith('mZAR_Attestation_02_26.pdf')) return new Response(new TextEncoder().encode('immutable-pdf-fixture'), { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`unexpected mZAR request ${target.url}`)
  })
}

describe('Mesh mZAR reserve adapter', () => {
  it('selects mZAR only for the exact issuer, home domain, and normalized index URL', () => {
    expect(anchorReserveConnectorProfile({ asset, homeDomain: 'mzar.co.za', attestationUrl: 'https://mzar.co.za/' })).toBe('mesh_mzar_pdf_v1')
    expect(anchorReserveConnectorProfile({ asset, homeDomain: 'other.example', attestationUrl: 'https://mzar.co.za/' })).toBe('axiom_json_v1')
  })

  it('parses the real provider layout with exact historical scope and units', () => {
    expect(parseMzarReserveReport(reportText, new URL('https://mzar.co.za/wp-content/uploads/2026/04/mZAR_Attestation_02_26.pdf'))).toEqual({
      periodEnd: '2026-02-28T15:00:00.000Z',
      publishedAt: '2026-03-25T05:43:01.000Z',
      reportedSupply: '4249400.26',
      reserveAmount: '4251446.27',
    })
  })

  it('discovers the latest report and emits only the isolated v0.2 observation contract', async () => {
    const connectImpl = connector()
    const result = await fetchMzarReserveObservation({
      observationId: 'observation_mzar', cycleId: 'cycle_mzar', anchorId: 'anchor_mzar', source, asset,
      connectImpl, resolve: async () => ['93.184.216.34'], extractPdfText: async (bytes) => {
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
        return reportText
      },
      clock: () => new Date('2026-04-01T12:00:00.000Z'),
    })
    expect(result).toMatchObject({ observation: {
      amount: expect.any(Object), methodologyVersion: 'anchor-reserve-comparison-v0.2',
      attestationPeriodEnd: '2026-02-28T15:00:00.000Z', publishedAt: '2026-03-25T05:43:01.000Z',
      attestation: {
        schema: 'mesh-mzar-reserve-report-v1', connectorProfile: 'mesh_mzar_pdf_v1',
        reportedSupply: expect.any(Object), reserveDenomination: 'ZAR', conversionPolicy: 'one_mzar_equals_one_zar',
        documentUrl: 'https://mzar.co.za/wp-content/uploads/2026/04/mZAR_Attestation_02_26.pdf',
      },
    } })
    if (!('observation' in result)) throw new Error('expected mZAR observation')
    expect(result.observation.amount.toString()).toBe('4251446.27')
    expect(result.observation.attestation.schema === 'mesh-mzar-reserve-report-v1' && result.observation.attestation.reportedSupply.toString()).toBe('4249400.26')
    expect(result.observation.attestation.evidenceSha256).toBe('ebd7abc583e0b1be2369f150e55ef632b806e7310da68a01dfcee9d3a4961318')
    expect(result.evidence.payload).toMatchObject({ pdfBase64: 'aW1tdXRhYmxlLXBkZi1maXh0dXJl' })
    expect(connectImpl).toHaveBeenCalledTimes(2)
  })

  it('fails closed when provider identity or filename period changes', () => {
    expect(() => parseMzarReserveReport(reportText.replaceAll(MZAR_ISSUER, `G${'A'.repeat(55)}`), new URL('https://mzar.co.za/wp-content/uploads/2026/04/mZAR_Attestation_02_26.pdf'))).toThrow('approved Stellar issuer')
    expect(() => parseMzarReserveReport(reportText, new URL('https://mzar.co.za/wp-content/uploads/2026/04/mZAR_Attestation_01_26.pdf'))).toThrow('filename')
  })

  it('cannot be selected for another asset or endpoint', async () => {
    const result = await fetchMzarReserveObservation({
      observationId: 'observation_mzar', cycleId: 'cycle_mzar', anchorId: 'anchor_mzar',
      source: { ...source, url: 'https://example.com/' }, asset,
      connectImpl: connector(), resolve: async () => ['93.184.216.34'], extractPdfText: async () => reportText,
    })
    expect(result).toMatchObject({ error: { code: 'invalid_configuration' } })
  })
})
