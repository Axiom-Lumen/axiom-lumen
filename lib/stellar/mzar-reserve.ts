import { createHash } from 'node:crypto'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
  MZAR_RESERVE_ATTESTATION_SCHEMA,
  MZAR_RESERVE_CONNECTOR_PROFILE,
  mzarAnchorReserveMethodologyConfig,
} from '../../config/methodology'
import { anchorReservesObservationSchema, creditAssetSchema, formatAssetId, type SourceIdentity } from '../contracts/domain'
import { fetchSafePublicHttps, readBoundedBytes, readBoundedText, UnsafeEndpointError, type ResolveHost, type SafeHttpsConnect } from './safe-http'
import { MZAR_ASSET_ID, MZAR_ATTESTATION_INDEX_URL, MZAR_HOME_DOMAIN, MZAR_ISSUER } from './mzar-profile'
import type { AnchorReserveConnectorError, AnchorReserveConnectorResult } from './anchor-reserve'

export const MZAR_RESERVE_CONNECTOR_VERSION = 'mesh-mzar-pdf-v1' as const

function timestamp(clock: () => Date) {
  const value = clock()
  if (!Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function connectorError(source: SourceIdentity, code: AnchorReserveConnectorError['code'], message: string, retrievedAt: string, status?: number): AnchorReserveConnectorResult {
  return { error: { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, ...(status === undefined ? {} : { status }) } }
}

function digest(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function reportLinks(indexText: string, collectedAt: Date) {
  const links = new Map<string, { url: URL; period: number }>()
  const matcher = /href=["']([^"']*mZAR_Attestation_(\d{2})_(\d{2})\.pdf)["']/gi
  for (const match of indexText.matchAll(matcher)) {
    const month = Number(match[2])
    const year = 2_000 + Number(match[3])
    if (month < 1 || month > 12) continue
    let url: URL
    try { url = new URL(match[1]!.replaceAll('&amp;', '&'), MZAR_ATTESTATION_INDEX_URL) } catch { continue }
    if (url.protocol !== 'https:' || url.hostname !== MZAR_HOME_DOMAIN || url.port ||
      !/^\/wp-content\/uploads\/\d{4}\/\d{2}\/mZAR_Attestation_\d{2}_\d{2}\.pdf$/.test(url.pathname)) continue
    const period = year * 100 + month
    const currentPeriod = collectedAt.getUTCFullYear() * 100 + collectedAt.getUTCMonth() + 1
    if (period <= currentPeriod) links.set(url.toString(), { url, period })
  }
  return [...links.values()].sort((left, right) => right.period - left.period || left.url.toString().localeCompare(right.url.toString()))
}

export async function extractMzarPdfText(bytes: Uint8Array) {
  const document = await getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise
  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' '))
    }
    const fields = await document.getFieldObjects()
    const fieldText = Object.values(fields ?? {}).flatMap((items) => items.flatMap((item) => {
      const value = (item as { value?: unknown }).value
      return typeof value === 'string' ? [value] : []
    }))
    return [...pages, ...fieldText].join('\n').replaceAll(/\s+/g, ' ').trim()
  } finally {
    await document.destroy()
  }
}

const monthNumbers: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

function sastTimestamp(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  const value = new Date(Date.UTC(year, month - 1, day, hour - 2, minute, second))
  const localCheck = new Date(value.getTime() + 2 * 60 * 60 * 1_000)
  if (
    localCheck.getUTCFullYear() !== year || localCheck.getUTCMonth() + 1 !== month || localCheck.getUTCDate() !== day ||
    localCheck.getUTCHours() !== hour || localCheck.getUTCMinutes() !== minute || localCheck.getUTCSeconds() !== second
  ) throw new Error('mZAR report contains an invalid SAST timestamp')
  return value.toISOString()
}

function twelveHour(value: string, meridiem: string) {
  const hour = Number(value)
  if (hour < 1 || hour > 12) throw new Error('mZAR report contains an invalid twelve-hour timestamp')
  return hour % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0)
}

export function parseMzarReserveReport(text: string, reportUrl: URL) {
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  const cutoff = normalized.match(/(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) at (\d{1,2})(?::(\d{2}))?\s*(AM|PM) South African Standard Time \(SAST\)/i)
  const signature = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)/i)
  const issued = normalized.match(/mZAR tokens issued and in circulation\..*?mZAR\s+([\d ]+\.\d{2})/i)
  const reserve = normalized.match(/ZAR reserved for mZAR token holders\..*?R\s*([\d ]+\.\d{2})/i)
  if (!cutoff || !signature || !issued || !reserve) throw new Error('mZAR report does not match the approved reserve report layout')
  if (!normalized.includes(MZAR_ISSUER)) throw new Error('mZAR report does not identify the approved Stellar issuer')
  if (!/1 mZAR is redeemable for 1 ZAR\. At all times/i.test(normalized)) throw new Error('mZAR report does not contain the approved one-to-one redemption assertion')
  if (!/INDEPENDENT ACCOUNTANT(?:’|')S REPORT/i.test(normalized) || !/Acredo Accounting \(Pty\) Ltd/i.test(normalized)) throw new Error('mZAR report does not contain the approved independent-accountant attribution')

  const month = monthNumbers[cutoff[2]!.toLowerCase()]!
  const year = Number(cutoff[3])
  const periodEnd = sastTimestamp(year, month, Number(cutoff[1]), twelveHour(cutoff[4]!, cutoff[6]!), Number(cutoff[5] ?? 0), 0)
  const publishedAt = sastTimestamp(Number(signature[3]), Number(signature[1]), Number(signature[2]), twelveHour(signature[4]!, signature[7]!), Number(signature[5]), Number(signature[6]))
  const filePeriod = reportUrl.pathname.match(/mZAR_Attestation_(\d{2})_(\d{2})\.pdf$/)
  if (!filePeriod || Number(filePeriod[1]) !== month || 2_000 + Number(filePeriod[2]) !== year) throw new Error('mZAR report filename does not match its stated cutoff period')
  if (Date.parse(publishedAt) < Date.parse(periodEnd)) throw new Error('mZAR report publication precedes its cutoff')
  if ((Date.parse(publishedAt) - Date.parse(periodEnd)) / 1_000 > mzarAnchorReserveMethodologyConfig.maximumPublicationDelaySeconds) throw new Error('mZAR report exceeds the approved publication delay')

  const normalizeAmount = (value: string) => value.replaceAll(' ', '')
  return { periodEnd, publishedAt, reportedSupply: normalizeAmount(issued[1]!), reserveAmount: normalizeAmount(reserve[1]!) }
}

export async function fetchMzarReserveObservation(options: {
  observationId: string
  cycleId: string
  anchorId: string
  source: SourceIdentity
  asset: unknown
  connectImpl?: SafeHttpsConnect
  resolve?: ResolveHost
  timeoutMs?: number
  maximumIndexBytes?: number
  maximumPdfBytes?: number
  extractPdfText?: (bytes: Uint8Array) => Promise<string>
  signal?: AbortSignal
  clock?: () => Date
}): Promise<AnchorReserveConnectorResult> {
  const clock = options.clock ?? (() => new Date())
  const retrievedAt = timestamp(clock)
  const collectedAt = new Date(retrievedAt)
  const asset = creditAssetSchema.parse(options.asset)
  if (formatAssetId(asset) !== MZAR_ASSET_ID || options.source.url !== MZAR_ATTESTATION_INDEX_URL || options.source.adapter !== 'anchor' || options.source.sourceClass !== 'anchor_self_reported') {
    return connectorError(options.source, 'invalid_configuration', 'The mZAR profile is locked to the verified mZAR issuer and attestation index', retrievedAt)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const indexResponse = await fetchSafePublicHttps(MZAR_ATTESTATION_INDEX_URL, { resolve: options.resolve, connectImpl: options.connectImpl, expectedHostname: MZAR_HOME_DOMAIN, init: { signal, redirect: 'manual', headers: { accept: 'text/html' } } })
    if (indexResponse.redirected || (indexResponse.status >= 300 && indexResponse.status < 400)) return connectorError(options.source, 'redirect_rejected', 'mZAR attestation index redirects are not accepted', timestamp(clock), indexResponse.status)
    if (!indexResponse.ok) return connectorError(options.source, 'non_200_response', `mZAR attestation index returned HTTP ${indexResponse.status}`, timestamp(clock), indexResponse.status)
    if (indexResponse.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html') return connectorError(options.source, 'unsupported_attestation', 'mZAR attestation index must use text/html', timestamp(clock), indexResponse.status)
    const indexText = await readBoundedText(indexResponse, options.maximumIndexBytes ?? 2_000_000)
    const reports = reportLinks(indexText, collectedAt)
    if (reports.length === 0) return connectorError(options.source, 'unsupported_attestation', 'mZAR attestation index contains no approved report links', timestamp(clock), indexResponse.status)
    const reportUrl = reports[0]!.url
    const reportResponse = await fetchSafePublicHttps(reportUrl, { resolve: options.resolve, connectImpl: options.connectImpl, expectedHostname: MZAR_HOME_DOMAIN, init: { signal, redirect: 'manual', headers: { accept: 'application/pdf' } } })
    if (reportResponse.redirected || (reportResponse.status >= 300 && reportResponse.status < 400)) return connectorError(options.source, 'redirect_rejected', 'mZAR reserve report redirects are not accepted', timestamp(clock), reportResponse.status)
    if (!reportResponse.ok) return connectorError(options.source, 'non_200_response', `mZAR reserve report returned HTTP ${reportResponse.status}`, timestamp(clock), reportResponse.status)
    if (reportResponse.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf') return connectorError(options.source, 'unsupported_attestation', 'mZAR reserve report must use application/pdf', timestamp(clock), reportResponse.status)
    const pdfBytes = await readBoundedBytes(reportResponse, options.maximumPdfBytes ?? 5_000_000)
    // PDF.js transfers (and therefore detaches) its input buffer. Parse an
    // isolated copy so the original bytes remain available for hashing and
    // immutable evidence persistence.
    const text = await (options.extractPdfText ?? extractMzarPdfText)(pdfBytes.slice())
    const report = parseMzarReserveReport(text, reportUrl)
    const completedAt = timestamp(clock)
    const observation = anchorReservesObservationSchema.parse({
      observationId: options.observationId,
      cycleId: options.cycleId,
      metric: 'anchor_reserves',
      anchorId: options.anchorId,
      asset,
      amount: report.reserveAmount,
      unit: { kind: 'asset_units', asset },
      attestationPeriodStart: report.periodEnd,
      attestationPeriodEnd: report.periodEnd,
      publishedAt: report.publishedAt,
      methodologyVersion: MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
      attestation: {
        schema: MZAR_RESERVE_ATTESTATION_SCHEMA,
        evidenceSha256: digest(pdfBytes),
        documentUrl: reportUrl.toString(),
        provider: 'Mesh Trade South Africa (Pty) Ltd',
        connectorProfile: MZAR_RESERVE_CONNECTOR_PROFILE,
        indexEvidenceSha256: digest(indexText),
        reportedSupply: report.reportedSupply,
        reserveDenomination: 'ZAR',
        conversionPolicy: 'one_mzar_equals_one_zar',
      },
      provenance: { source: options.source, sourceTimestamp: report.periodEnd, retrievedAt: completedAt },
    })
    return { observation, evidence: { rawText: text, payload: { indexText, pdfBase64: Buffer.from(pdfBytes).toString('base64'), reportUrl: reportUrl.toString() }, connectorVersion: MZAR_RESERVE_CONNECTOR_VERSION } }
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    const completedAt = timestamp(clock)
    const size = cause instanceof Error && cause.message.includes('maximum size')
    return connectorError(options.source,
      cause instanceof UnsafeEndpointError ? 'unsafe_endpoint' : cause instanceof Error && cause.name === 'AbortError' ? 'request_aborted' : size ? 'response_too_large' : 'malformed_payload',
      cause instanceof UnsafeEndpointError ? 'mZAR evidence endpoint did not pass public HTTPS policy' : cause instanceof Error && cause.name === 'AbortError' ? 'mZAR evidence request timed out' : size ? 'mZAR evidence exceeds the response limit' : 'mZAR reserve report failed strict validation',
      completedAt)
  } finally {
    clearTimeout(timeout)
  }
}
