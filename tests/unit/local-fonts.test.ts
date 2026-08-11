import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const fontDigests = {
  'fraunces-variable.woff2': 'e6638ea113d0027354a08f957a4068975c8066395a0d0f7bb7861f6409621be3',
  'ibm-plex-sans-regular.woff2': 'ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a',
  'ibm-plex-sans-medium.woff2': '5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d',
  'ibm-plex-sans-semibold.woff2': 'f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205',
  'ibm-plex-mono-regular.woff2': 'ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350',
  'ibm-plex-mono-medium.woff2': '33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25',
} as const

describe('local font assets', () => {
  it('loads fonts locally without a Google Fonts build dependency', () => {
    const layout = readFileSync(resolve(process.cwd(), 'app/layout.tsx'), 'utf8')
    expect(layout).toContain("from 'next/font/local'")
    expect(layout).not.toContain('next/font/google')
    expect(layout).not.toContain('fonts.googleapis.com')
    expect(layout).not.toContain('fonts.gstatic.com')
  })

  it.each(Object.entries(fontDigests))('retains the reviewed %s asset', (file, expectedDigest) => {
    const bytes = readFileSync(resolve(process.cwd(), 'app/fonts', file))
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedDigest)
  })

  it('retains both upstream Open Font License notices', () => {
    for (const license of ['FRAUNCES-OFL.txt', 'IBM-PLEX-OFL.txt']) {
      const text = readFileSync(resolve(process.cwd(), 'app/fonts/licenses', license), 'utf8')
      expect(text).toContain('SIL OPEN FONT LICENSE')
      expect(text).toContain('Version 1.1')
    }
  })
})
