export function apiKeyWithTamperedSecret(key: string): string {
  const last = key.at(-1)!
  return key.slice(0, -1) + (last === 'A' ? 'B' : 'A')
}
