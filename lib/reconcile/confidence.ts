export const CONFIDENCE_COMPONENT_KEYS = [
  'agreement',
  'freshness',
  'availability',
  'diversity',
  'spread',
] as const

export type ConfidenceComponentKey = (typeof CONFIDENCE_COMPONENT_KEYS)[number]
export type ConfidenceComponents = Record<ConfidenceComponentKey, number>
export type BaseConfidenceComponent = Exclude<ConfidenceComponentKey, 'diversity'>
export type ConfidenceCoefficients = Record<BaseConfidenceComponent, number>

export interface ConfidenceCap {
  id: string
  maximum: number
  applies: boolean
}

export interface ConfidenceResult<TFormulaVersion extends string = string> {
  score: number
  uncappedScore: number
  formulaVersion: TFormulaVersion
  components: ConfidenceComponents
  capsApplied: string[]
}

function assertUnitInterval(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number from 0 to 1`)
  }
}

/**
 * Computes an auditable quality indicator, not a probability of correctness.
 * Diversity multiplies the weighted evidence score so replicas cannot manufacture independence.
 */
export function computeConfidence<TFormulaVersion extends string>({
  formulaVersion,
  components,
  coefficients,
  caps = [],
}: {
  formulaVersion: TFormulaVersion
  components: ConfidenceComponents
  coefficients: ConfidenceCoefficients
  caps?: readonly ConfidenceCap[]
}): ConfidenceResult<TFormulaVersion> {
  if (!formulaVersion.trim()) throw new Error('formulaVersion must not be empty')
  CONFIDENCE_COMPONENT_KEYS.forEach((key) => assertUnitInterval(`components.${key}`, components[key]))

  const coefficientEntries = Object.entries(coefficients) as [BaseConfidenceComponent, number][]
  coefficientEntries.forEach(([key, value]) => assertUnitInterval(`coefficients.${key}`, value))
  const coefficientTotal = coefficientEntries.reduce((total, [, value]) => total + value, 0)
  if (Math.abs(coefficientTotal - 1) > Number.EPSILON * 10) {
    throw new Error('confidence coefficients must sum to 1')
  }

  const weightedEvidence = coefficientEntries.reduce(
    (total, [key, coefficient]) => total + components[key] * coefficient,
    0,
  )
  const uncappedScore = weightedEvidence * components.diversity
  let score = uncappedScore
  const capsApplied: string[] = []

  for (const cap of caps) {
    if (!cap.id.trim()) throw new Error('confidence cap id must not be empty')
    assertUnitInterval(`cap ${cap.id}`, cap.maximum)
    if (cap.applies && score > cap.maximum) {
      score = cap.maximum
      capsApplied.push(cap.id)
    }
  }

  return {
    score: Number(score.toFixed(4)),
    uncappedScore,
    formulaVersion,
    components: { ...components },
    capsApplied,
  }
}
