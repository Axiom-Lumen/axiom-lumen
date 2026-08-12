import { MZAR_RESERVE_CONNECTOR_PROFILE } from '../../config/methodology'
import { formatAssetId, type AssetId } from '../contracts/domain'

export const MZAR_ISSUER = 'GCBNWTCCMC32UHZ5OCC2PNMFDGXRVPA7MFFBFFTCVW77SX5PMRB7Q4BY' as const
export const MZAR_ASSET_ID = `mZAR:${MZAR_ISSUER}` as const
export const MZAR_HOME_DOMAIN = 'mzar.co.za' as const
export const MZAR_ATTESTATION_INDEX_URL = 'https://mzar.co.za/' as const

export type AnchorReserveConnectorProfile = 'axiom_json_v1' | typeof MZAR_RESERVE_CONNECTOR_PROFILE

export function anchorReserveConnectorProfile(input: {
  asset: AssetId
  homeDomain: string
  attestationUrl: string
}): AnchorReserveConnectorProfile {
  if (
    formatAssetId(input.asset) === MZAR_ASSET_ID &&
    input.homeDomain === MZAR_HOME_DOMAIN &&
    new URL(input.attestationUrl).toString() === MZAR_ATTESTATION_INDEX_URL
  ) return MZAR_RESERVE_CONNECTOR_PROFILE
  return 'axiom_json_v1'
}
