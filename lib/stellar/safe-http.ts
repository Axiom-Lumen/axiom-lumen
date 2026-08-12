import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

export type ResolveHost = (hostname: string) => Promise<readonly string[]>

export interface SafePublicHttpsTarget {
  url: URL
  addresses: readonly string[]
}

export type SafeHttpsConnect = (target: SafePublicHttpsTarget, init?: RequestInit) => Promise<Response>

export class UnsafeEndpointError extends Error {
  override name = 'UnsafeEndpointError'
}

function restrictedIpv4(address: string) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = octets as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
}

function restrictedIpv6(address: string) {
  const normalized = address.toLowerCase().split('%', 1)[0]!
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  return mapped ? restrictedIpv4(mapped) : false
}

export function isPublicAddress(address: string) {
  const family = isIP(address)
  return family === 4 ? !restrictedIpv4(address) : family === 6 ? !restrictedIpv6(address) : false
}

export const resolveHost: ResolveHost = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

function validatePublicHttpsUrl(
  input: string | URL,
  options: { expectedHostname?: string } = {},
) {
  const url = input instanceof URL ? new URL(input) : new URL(input)
  if (url.protocol !== 'https:') throw new UnsafeEndpointError('endpoint must use HTTPS')
  if (url.username || url.password) throw new UnsafeEndpointError('endpoint must not contain credentials')
  if (url.port && url.port !== '443') throw new UnsafeEndpointError('endpoint must use the standard HTTPS port')
  if (options.expectedHostname && url.hostname.toLowerCase() !== options.expectedHostname.toLowerCase()) {
    throw new UnsafeEndpointError('endpoint hostname does not match the verified home domain')
  }
  url.hash = ''
  return url
}

export async function assertSafePublicHttpsUrl(
  input: string | URL,
  options: { expectedHostname?: string; resolve?: ResolveHost } = {},
) {
  return (await resolveSafePublicHttpsTarget(input, options)).url
}

async function resolveSafePublicHttpsTarget(
  input: string | URL,
  options: { expectedHostname?: string; resolve?: ResolveHost } = {},
): Promise<SafePublicHttpsTarget> {
  const url = validatePublicHttpsUrl(input, options)
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await (options.resolve ?? resolveHost)(url.hostname)
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new UnsafeEndpointError('endpoint resolves to a non-public address')
  }
  return { url, addresses: [...new Set(addresses)] }
}

const pinnedHttpsFetch: SafeHttpsConnect = (target, init = {}) => {
  if (init.method && init.method !== 'GET') throw new Error('safe HTTPS transport supports GET requests only')
  const address = target.addresses[0]
  if (!address) throw new Error('safe HTTPS target has no validated address')
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers)
    headers.set('host', target.url.host)
    const request = httpsRequest({
      protocol: 'https:',
      hostname: address,
      port: 443,
      servername: isIP(target.url.hostname) ? undefined : target.url.hostname,
      method: 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      headers: Object.fromEntries(headers.entries()),
    }, (incoming) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item))
        else if (value !== undefined) responseHeaders.set(name, value)
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }))
    })
    const abort = () => request.destroy(new DOMException('Request was aborted', 'AbortError'))
    if (init.signal?.aborted) abort()
    else init.signal?.addEventListener('abort', abort, { once: true })
    request.once('error', reject)
    request.once('close', () => init.signal?.removeEventListener('abort', abort))
    request.end()
  })
}

/** Resolves and validates a public HTTPS target, then pins the real connection to that address set. */
export async function fetchSafePublicHttps(
  input: string | URL,
  options: {
    expectedHostname?: string
    resolve?: ResolveHost
    connectImpl?: SafeHttpsConnect
    init?: RequestInit
  } = {},
) {
  const target = await resolveSafePublicHttpsTarget(input, options)
  return (options.connectImpl ?? pinnedHttpsFetch)(target, options.init)
}

export async function readBoundedText(response: Response, maximumBytes: number) {
  const bytes = await readBoundedBytes(response, maximumBytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export async function readBoundedBytes(response: Response, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('maximumBytes must be positive')
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel('response exceeds maximum size')
    throw new Error('response exceeds maximum size')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximumBytes) {
        await reader.cancel('response exceeds maximum size')
        throw new Error('response exceeds maximum size')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
