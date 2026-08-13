import { readFileSync } from 'node:fs'

const binaryExtensions = /\.(?:avif|gif|ico|jpe?g|pdf|png|webp|woff2?|zip)$/i
const patterns = [
  {
    name: 'private key material',
    expression: new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''), 'g'),
  },
  { name: 'Axiom API key', expression: /axl_(?:live|test)_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{32,}/g },
  { name: 'GitHub token', expression: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'AWS access key', expression: /AKIA[A-Z0-9]{16}/g },
  { name: 'Slack token', expression: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  {
    name: 'credential-bearing database URL',
    expression: /postgres(?:ql)?:\/\/[^\s:'"`]+:([^\s@'"`]{12,})@[^\s/'"`]+/g,
    valueGroup: 1,
  },
  {
    name: 'hard-coded credential assignment',
    expression: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*(['"])([^'"\r\n]{24,})\1/gi,
    valueGroup: 2,
    requireEntropy: true,
  },
]
const placeholder = /(?:example|fake|fixture|managed-secret|must-not|placeholder|prior-key|signing-secret|store-in-a-secret-manager|super-secret|test-only)/i

function entropy(value) {
  const frequencies = new Map()
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  return [...frequencies.values()].reduce((total, count) => {
    const probability = count / value.length
    return total - probability * Math.log2(probability)
  }, 0)
}

function findingsForContent(content) {
  const findings = []
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0
    for (const match of content.matchAll(pattern.expression)) {
      const candidate = match[pattern.valueGroup ?? 0] ?? match[0]
      if (placeholder.test(candidate)) continue
      if (pattern.requireEntropy && entropy(candidate) < 3.5) continue
      findings.push({ index: match.index, name: pattern.name })
    }
  }
  return findings
}

function runDetectorSelfTests() {
  const positives = [
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['axl_live_', 'AbCdEfGhIjKl', '_', 'aB3dE5fG7hI9jK1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f'].join(''),
    ['ghp_', 'A'.repeat(36)].join(''),
    ['AKIA', 'A1B2C3D4E5F6G7H8'].join(''),
    ['password="', 'j4R!n8Z@q2V#s6X$w9T%k3M&', '"'].join(''),
  ]
  for (const value of positives) {
    if (findingsForContent(value).length === 0) throw new Error('secret detector positive self-test failed')
  }
  const negatives = [
    'AXIOM_SITE_API_KEY=axl_live_store-in-a-secret-manager',
    'DATABASE_URL=postgresql://axiom:axiom@127.0.0.1:55432/axiom_lumen',
    'const token = process.env.ANCHOR_EMAIL_RELAY_TOKEN',
  ]
  for (const value of negatives) {
    if (findingsForContent(value).length > 0) throw new Error('secret detector negative self-test failed')
  }
}

runDetectorSelfTests()
const input = readFileSync(0, 'utf8')
const files = input.split('\0').filter(Boolean)
if (files.length === 0) throw new Error('secret scan received no repository files')

const findings = []
for (const file of files) {
  if (binaryExtensions.test(file) || file === 'scripts/check-secrets.mjs') continue
  const content = readFileSync(file, 'utf8')
  for (const finding of findingsForContent(content)) {
    const line = content.slice(0, finding.index).split('\n').length
    findings.push(`${file}:${line}: ${finding.name}`)
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential committed secrets detected:\n${findings.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Secret scan and detector self-tests passed (${files.length} repository files inspected).\n`)
}
