export const DOC_CODES = {
  home: "AL-INTRO-01",
  methodology: "AL-SPEC-02",
  docs: "AL-DOCS-03",
  pricing: "AL-RATE-04",
  anchors: "AL-ANCHOR-05",
  about: "AL-ABOUT-06",
} as const;
 
export type DocCodeKey = keyof typeof DOC_CODES;