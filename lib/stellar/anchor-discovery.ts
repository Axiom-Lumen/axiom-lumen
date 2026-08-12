import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { creditAssetSchema, formatAssetId, type NetworkIdentity } from '../contracts/domain'
import { assertHorizonEndpointAllowed, type HorizonEndpointPolicy } from './horizon'
import { assertSafePublicHttpsUrl, fetchSafePublicHttps, readBoundedText, type ResolveHost, type SafeHttpsConnect } from './safe-http'

const accountSchema = z.object({ account_id: z.string(), home_domain: z.string().trim().min(1).max(253).optional() }).passthrough()
const horizonRootSchema = z.object({ network_passphrase: z.string().trim().min(1) }).passthrough()
const currencySchema = z.object({
  code: z.string(),
  issuer: z.string(),
  is_asset_anchored: z.boolean().optional(),
  anchor_asset_type: z.string().optional(),
  anchor_asset: z.string().optional(),
  attestation_of_reserve: z.string().url().optional(),
}).passthrough()
const stellarTomlSchema = z.object({
  NETWORK_PASSPHRASE: z.string().optional(),
  DOCUMENTATION: z.object({
    ORG_NAME: z.string().trim().min(1).max(200).optional(),
    ORG_OFFICIAL_EMAIL: z.string().email().optional(),
    ORG_SUPPORT_EMAIL: z.string().email().optional(),
  }).passthrough().optional(),
  PRINCIPALS: z.array(z.object({ email: z.string().email().optional() }).passthrough()).optional(),
  CURRENCIES: z.array(currencySchema).min(1),
}).passthrough()

export interface VerifiedAnchorDiscovery {
  issuer: string
  asset: z.infer<typeof creditAssetSchema>
  homeDomain: string
  organizationName: string
  stellarTomlUrl: string
  attestationUrl: string
  anchorAssetType: string | null
  anchorAsset: string | null
  contacts: readonly { kind: 'email'; endpoint: string }[]
  verifiedAt: string
  evidence: {
    accountSha256: string
    horizonRootSha256: string
    stellarTomlSha256: string
    networkPassphrase: string
  }
}

export interface AnchorDiscoveryOptions {
  horizonUrl: string
  network: NetworkIdentity
  asset: unknown
  connectImpl?: SafeHttpsConnect
  resolve?: ResolveHost
  endpointPolicy?: HorizonEndpointPolicy
  timeoutMs?: number
  maximumAccountBytes?: number
  maximumTomlBytes?: number
  clock?: () => Date
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHomeDomain(value: string) {
  if (value.includes('://') || value.includes('/') || value.includes('@')) throw new Error('home domain must be a hostname')
  const url = new URL(`https://${value}`)
  if (url.port || url.pathname !== '/' || url.hostname !== value.toLowerCase()) throw new Error('home domain must be canonical lowercase DNS')
  return url.hostname
}

async function getText(url: URL, options: {
  connectImpl?: SafeHttpsConnect
  signal: AbortSignal
  maximumBytes: number
  accept: string
  mediaTypes: readonly string[]
  resolve?: ResolveHost
}) {
  const init = { signal: options.signal, redirect: 'manual' as const, headers: { accept: options.accept } }
  const response = await fetchSafePublicHttps(url, { connectImpl: options.connectImpl, resolve: options.resolve, init })
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('redirects are not accepted during anchor discovery')
  if (!response.ok) throw new Error(`anchor discovery request returned HTTP ${response.status}`)
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!mediaType || !options.mediaTypes.includes(mediaType)) throw new Error('anchor discovery response has an unsupported content type')
  return readBoundedText(response, options.maximumBytes)
}

/** Verifies the issuer -> home_domain -> SEP-1 currency binding before attributing an attestation URL. */
export async function discoverAnchor(options: AnchorDiscoveryOptions): Promise<VerifiedAnchorDiscovery> {
  const asset = creditAssetSchema.parse(options.asset)
  const clock = options.clock ?? (() => new Date())
  const now = clock()
  if (!Number.isFinite(now.getTime())) throw new Error('clock must return a valid date')
  const horizonRoot = new URL(options.horizonUrl)
  if (horizonRoot.protocol !== 'https:') throw new Error('Horizon URL must use HTTPS for anchor discovery')
  assertHorizonEndpointAllowed(horizonRoot, options.endpointPolicy ?? {})
  horizonRoot.pathname = `${horizonRoot.pathname.replace(/\/+$/, '')}/`
  horizonRoot.search = ''
  horizonRoot.hash = ''
  const horizonAccount = new URL(`accounts/${asset.issuer}`, horizonRoot)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const rootText = await getText(horizonRoot, { connectImpl: options.connectImpl, resolve: options.resolve, signal: controller.signal, maximumBytes: options.maximumAccountBytes ?? 256_000, accept: 'application/json', mediaTypes: ['application/json'] })
    const root = horizonRootSchema.parse(JSON.parse(rootText))
    if (root.network_passphrase !== options.network.passphrase) throw new Error('Horizon network passphrase does not match the configured network')
    const accountText = await getText(horizonAccount, { connectImpl: options.connectImpl, resolve: options.resolve, signal: controller.signal, maximumBytes: options.maximumAccountBytes ?? 256_000, accept: 'application/json', mediaTypes: ['application/json'] })
    const account = accountSchema.parse(JSON.parse(accountText))
    if (account.account_id !== asset.issuer) throw new Error('Horizon account identity does not match the issuer')
    if (!account.home_domain) throw new Error('issuer account does not publish a home domain')
    const homeDomain = canonicalHomeDomain(account.home_domain)
    const stellarTomlUrl = await assertSafePublicHttpsUrl(`https://${homeDomain}/.well-known/stellar.toml`, { expectedHostname: homeDomain, resolve: options.resolve })
    const tomlText = await getText(stellarTomlUrl, { connectImpl: options.connectImpl, signal: controller.signal, maximumBytes: options.maximumTomlBytes ?? 512_000, accept: 'text/plain', mediaTypes: ['text/plain'], resolve: options.resolve })
    const parsed = stellarTomlSchema.parse(parseToml(tomlText))
    if (parsed.NETWORK_PASSPHRASE && parsed.NETWORK_PASSPHRASE !== options.network.passphrase) {
      throw new Error('stellar.toml network passphrase does not match the configured network')
    }
    const matches = parsed.CURRENCIES.filter((currency) => currency.code === asset.code && currency.issuer === asset.issuer)
    if (matches.length !== 1) throw new Error('stellar.toml must contain exactly one matching currency entry')
    const currency = matches[0]!
    if (currency.is_asset_anchored !== true) throw new Error('matching currency is not declared as anchored')
    if (!currency.attestation_of_reserve) throw new Error('matching currency does not publish attestation_of_reserve')
    const attestationUrl = await assertSafePublicHttpsUrl(currency.attestation_of_reserve, { resolve: options.resolve })
    const contacts = [
      parsed.DOCUMENTATION?.ORG_OFFICIAL_EMAIL,
      parsed.DOCUMENTATION?.ORG_SUPPORT_EMAIL,
      ...(parsed.PRINCIPALS ?? []).map((principal) => principal.email),
    ].flatMap((email) => email && email.toLowerCase().endsWith(`@${homeDomain}`) ? [{ kind: 'email' as const, endpoint: email.toLowerCase() }] : [])
    return {
      issuer: asset.issuer,
      asset,
      homeDomain,
      organizationName: parsed.DOCUMENTATION?.ORG_NAME ?? homeDomain,
      stellarTomlUrl: stellarTomlUrl.toString(),
      attestationUrl: attestationUrl.toString(),
      anchorAssetType: currency.anchor_asset_type ?? null,
      anchorAsset: currency.anchor_asset ?? null,
      contacts: [...new Map(contacts.map((contact) => [contact.endpoint, contact])).values()],
      verifiedAt: now.toISOString(),
      evidence: { accountSha256: digest(accountText), horizonRootSha256: digest(rootText), stellarTomlSha256: digest(tomlText), networkPassphrase: options.network.passphrase },
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function anchorDiscoverySubject(discovery: VerifiedAnchorDiscovery) {
  return `${discovery.homeDomain}:${formatAssetId(discovery.asset)}`
}
