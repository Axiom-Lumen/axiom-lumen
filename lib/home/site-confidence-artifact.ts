import { apiAuthenticationRequired, parseApiKey } from '../api-access/key'
import { loadConfidenceArtifact } from './confidence-artifact'

export function resolveSiteApiAccess(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const authenticationRequired = apiAuthenticationRequired(environment)
  if (!authenticationRequired) return { authenticationRequired, apiKey: undefined }
  const apiKey = environment.AXIOM_SITE_API_KEY
  if (!parseApiKey(apiKey ?? null)) {
    throw new Error('AXIOM_SITE_API_KEY must be a valid API key when authentication is required')
  }
  return { authenticationRequired, apiKey }
}

export async function loadFirstPartyConfidenceArtifact(
  load: typeof loadConfidenceArtifact = loadConfidenceArtifact,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const access = resolveSiteApiAccess(environment)
  return {
    state: await load({ apiKey: access.apiKey }),
    refreshEnabled: !access.authenticationRequired,
  }
}

export async function loadSiteConfidenceArtifact() {
  return (await loadFirstPartyConfidenceArtifact()).state
}
