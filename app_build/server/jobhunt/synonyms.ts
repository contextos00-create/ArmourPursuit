'use strict';

/**
 * Equivalent spellings of the same skill, so "E2E testing" in a posting counts
 * as evidence when the resume says "End-to-End". Only true equivalents belong
 * here; "test automation" is not a synonym of "Cypress".
 */

import { containsTerm, normalizeTerm } from './text';

const GROUPS: string[][] = [
  ['end-to-end', 'e2e', 'end to end'],
  ['postgres', 'postgresql'],
  ['kubernetes', 'k8s'],
  ['ci/cd', 'continuous integration', 'ci cd', 'cicd'],
  ['node.js', 'nodejs'],
  ['javascript', 'ecmascript'],
  ['typescript', 'ts'],
  ['qa', 'quality assurance'],
  ['accessibility', 'a11y', 'wcag'],
  ['api', 'apis', 'rest api', 'rest apis'],
  ['github actions', 'gh actions'],
  ['gitlab ci', 'gitlab ci/cd'],
  ['machine learning', 'ml'],
  ['amazon web services', 'aws'],
  ['google cloud', 'gcp'],
  ['react', 'react.js', 'reactjs'],
  ['next.js', 'nextjs'],
  ['regression', 'regression testing'],
  ['exploratory', 'exploratory testing'],
  ['manual', 'manual testing'],
  ['functional', 'functional testing'],
  ['integration', 'integration testing'],
  ['api testing', 'api'],
  ['performance testing', 'load testing'],
  ['test plans', 'test plan', 'test planning'],
  ['defect tracking', 'bug tracking', 'defect triage'],
  ['sdet', 'software development engineer in test'],
  ['linux', 'embedded linux'],
];

const INDEX = new Map<string, Set<string>>();
for (const group of GROUPS) {
  const norm = group.map(normalizeTerm);
  for (const t of norm) {
    if (!INDEX.has(t)) INDEX.set(t, new Set());
    for (const o of norm) if (o !== t) INDEX.get(t)!.add(o);
  }
}

export function aliases(term: string): string[] {
  return [...(INDEX.get(normalizeTerm(term)) ?? [])];
}

/** containsTerm, but any equivalent spelling also counts. */
export function matchesTerm(haystack: string, term: string): boolean {
  if (containsTerm(haystack, term)) return true;
  // Two-letter aliases ("ts", "ml") are too ambiguous to search for in prose.
  return aliases(term).some((a) => a.length > 2 && containsTerm(haystack, a));
}
