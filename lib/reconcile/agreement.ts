export interface WeightedAgreementContribution {
  effectiveWeight: number
  agrees: boolean
}

export interface WeightedAgreementResult {
  score: number
  agreeingWeight: number
  totalWeight: number
}

function assertNonNegativeFinite(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
}

/** Measures consensus as the share of effective weight inside the agreement band. */
export function computeWeightedAgreement(
  contributions: readonly WeightedAgreementContribution[],
): WeightedAgreementResult {
  let agreeingWeight = 0
  let totalWeight = 0

  contributions.forEach((contribution, index) => {
    assertNonNegativeFinite(`contributions[${index}].effectiveWeight`, contribution.effectiveWeight)
    totalWeight += contribution.effectiveWeight
    if (contribution.agrees) agreeingWeight += contribution.effectiveWeight
  })

  return {
    score: totalWeight === 0 ? 0 : agreeingWeight / totalWeight,
    agreeingWeight,
    totalWeight,
  }
}

export function computeAvailabilityScore({
  usableSources,
  configuredSources,
}: {
  usableSources: number
  configuredSources: number
}) {
  if (!Number.isSafeInteger(usableSources) || usableSources < 0) {
    throw new Error('usableSources must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(configuredSources) || configuredSources < 0) {
    throw new Error('configuredSources must be a non-negative safe integer')
  }
  if (usableSources > configuredSources) {
    throw new Error('usableSources cannot exceed configuredSources')
  }

  return configuredSources === 0 ? 0 : usableSources / configuredSources
}

export interface SourceClassDiversityResult {
  score: number
  representedClasses: string[]
  expectedClasses: string[]
}

/** Measures how many expected independent source classes are represented by usable observations. */
export function computeSourceClassDiversity({
  representedSourceClasses,
  expectedSourceClasses,
}: {
  representedSourceClasses: readonly string[]
  expectedSourceClasses: readonly string[]
}): SourceClassDiversityResult {
  const normalize = (values: readonly string[], name: string) =>
    new Set(
      values.map((value, index) => {
        const normalized = value.trim()
        if (!normalized) throw new Error(`${name}[${index}] must not be empty`)
        return normalized
      }),
    )

  const represented = normalize(representedSourceClasses, 'representedSourceClasses')
  const expected = normalize(expectedSourceClasses, 'expectedSourceClasses')
  const representedExpected = [...expected].filter((sourceClass) => represented.has(sourceClass)).sort()

  return {
    score: expected.size === 0 ? 0 : representedExpected.length / expected.size,
    representedClasses: representedExpected,
    expectedClasses: [...expected].sort(),
  }
}
