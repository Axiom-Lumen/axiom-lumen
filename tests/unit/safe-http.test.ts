import { describe, expect, it, vi } from 'vitest'
import { fetchSafePublicHttps, readBoundedText } from '../../lib/stellar/safe-http'

describe('safe public HTTPS transport', () => {
  it('uses one validated DNS result set for a request', async () => {
    const resolve = vi.fn(async () => ['93.184.216.34'])
    const connectImpl = vi.fn(async () => new Response('ok'))
    const response = await fetchSafePublicHttps('https://evidence.example/report', { resolve, connectImpl })
    expect(await response.text()).toBe('ok')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(connectImpl).toHaveBeenCalledWith({ url: new URL('https://evidence.example/report'), addresses: ['93.184.216.34'] }, undefined)
  })

  it('stops reading a chunked response as soon as the byte limit is exceeded', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'))
        controller.enqueue(new TextEncoder().encode('5678'))
      },
      cancel() { cancelled = true },
    }))
    await expect(readBoundedText(response, 6)).rejects.toThrow('maximum size')
    expect(cancelled).toBe(true)
  })

  it('cancels a response whose declared length exceeds the limit', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { headers: { 'content-length': '100' } })
    await expect(readBoundedText(response, 10)).rejects.toThrow('maximum size')
    expect(cancelled).toBe(true)
  })
})
