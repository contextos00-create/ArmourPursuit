'use strict';

/**
 * Deterministic requirement extraction from a posting's plain text.
 *
 * Splits the description into sections, tags bullet lines under
 * "requirements / qualifications" as must-haves and lines under
 * "preferred / nice to have / bonus" as nice-to-haves, and pulls keywords
 * from each line using a known-term vocabulary (built-in list plus every
 * skill in the user's master resume) and tech-looking tokens.
 */

import type { MasterResume, Requirement } from './types';
import { containsTerm, normalizeTerm } from './text';

const MUST_HEADINGS = /(requirements?|qualifications?|what you('|’)?ll (need|bring)|you (have|bring)|must[- ]haves?|who you are|about you|skills|experience)\b/i;
const NICE_HEADINGS = /(preferred|nice[- ]to[- ]haves?|bonus|plus|desired|ideally|extra credit)\b/i;
const STOP_HEADINGS = /(benefits|perks|compensation|salary|about (us|the company)|equal opportunity|eeo|our values|why join|what we offer)\b/i;

/** Common skills and tools. The master resume's own skills are added at runtime. */
const BUILTIN_TERMS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust', 'c++', 'c#', 'ruby', 'php', 'kotlin', 'swift', 'scala', 'sql', 'r',
  'react', 'next.js', 'node.js', 'node', 'vue', 'angular', 'svelte', 'tanstack', 'graphql', 'rest', 'grpc', 'html', 'css', 'tailwind',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'ci/cd', 'linux', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb',
  'redis', 'kafka', 'spark', 'airflow', 'dbt', 'snowflake', 'bigquery', 'elasticsearch', 'llm', 'llms', 'machine learning', 'nlp',
  'pytorch', 'tensorflow', 'rag', 'embeddings', 'data pipelines', 'etl', 'microservices', 'distributed systems', 'api design',
  'figma', 'ux', 'product management', 'agile', 'scrum', 'jira', 'salesforce', 'hubspot', 'excel', 'tableau', 'looker', 'power bi',
  'seo', 'sem', 'crm', 'b2b', 'saas', 'stakeholder management', 'project management', 'customer success', 'sales', 'marketing',
  'leadership', 'mentoring', 'communication', 'analytics', 'a/b testing', 'security', 'observability', 'accessibility',
  // QA and test engineering
  'qa', 'quality assurance', 'sdet', 'test automation', 'cypress', 'playwright', 'selenium', 'webdriverio', 'appium', 'jest', 'mocha',
  'pytest', 'junit', 'testng', 'cucumber', 'bdd', 'tdd', 'postman', 'rest assured', 'soapui', 'testrail', 'qmetry', 'zephyr', 'xray',
  'k6', 'jmeter', 'gatling', 'load testing', 'performance testing', 'regression testing', 'exploratory testing', 'manual testing',
  'functional testing', 'integration testing', 'api testing', 'end-to-end', 'e2e', 'unit testing', 'test plans', 'test cases',
  'defect tracking', 'wcag', 'axe-core', 'github actions', 'gitlab ci', 'jenkins', 'circleci', 'confluence', 'mobile testing',
  'android', 'ios', 'kotlin', 'mongodb', 'ssh', 'embedded linux', 'risk-based testing',
];

const GENERIC = new Set([
  'experience', 'years', 'year', 'strong', 'ability', 'skills', 'knowledge', 'work', 'working', 'team', 'teams', 'and', 'or', 'with',
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'on', 'our', 'you', 'your', 'we', 'is', 'are', 'be', 'as', 'at', 'by', 'from', 'excellent',
  'proven', 'track', 'record', 'including', 'etc', 'plus', 'preferred', 'required', 'bonus', 'familiarity', 'understanding', 'solid',
]);

function isHeading(line: string): boolean {
  const bare = line.replace(/[:*#]+$/g, '').replace(/^[#*\s]+/, '').trim();
  return bare.length > 0 && bare.length <= 60 && !/^[-*•]/.test(line) && (/:$/.test(line) || bare.split(' ').length <= 6);
}

export function buildVocabulary(master?: MasterResume): string[] {
  const terms = new Set(BUILTIN_TERMS);
  for (const s of master?.skills ?? []) {
    terms.add(normalizeTerm(s.name));
    for (const k of s.keywords ?? []) terms.add(normalizeTerm(k));
  }
  for (const p of master?.projects ?? []) for (const k of p.keywords ?? []) terms.add(normalizeTerm(k));
  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function extractKeywords(line: string, vocabulary: string[]): string[] {
  const found = new Set<string>();
  for (const term of vocabulary) {
    // Single-letter terms like "r" are too ambiguous to match in prose.
    if (term.length < 2) continue;
    if (containsTerm(line, term)) found.add(term);
  }
  // Tech-looking tokens not in the vocabulary: CamelCase, dotted, or with +/#.
  for (const raw of line.match(/\b[A-Za-z][A-Za-z0-9]*(?:[.+#][A-Za-z0-9+#]+)+\b|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g) || []) {
    const t = normalizeTerm(raw);
    if (t && !GENERIC.has(t)) found.add(t);
  }
  // Drop terms fully contained in a longer found term ("node" inside "node.js").
  const list = [...found];
  return list.filter((t) => !list.some((o) => o !== t && o.length > t.length && containsTerm(o, t)));
}

export function extractRequirements(descriptionText: string, master?: MasterResume): Requirement[] {
  const vocabulary = buildVocabulary(master);
  const lines = descriptionText.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: Requirement[] = [];
  let section: 'must' | 'nice' | 'none' | 'stop' = 'none';
  for (const line of lines) {
    if (isHeading(line)) {
      if (STOP_HEADINGS.test(line)) section = 'stop';
      else if (NICE_HEADINGS.test(line)) section = 'nice';
      else if (MUST_HEADINGS.test(line)) section = 'must';
      continue;
    }
    if (section === 'stop') continue;
    const isBullet = /^[-*•]\s*/.test(line);
    const text = line.replace(/^[-*•]\s*/, '').trim();
    // Inline cues override section ("Bonus: Kafka", "Nice to have ...").
    const kind: 'must' | 'nice' = NICE_HEADINGS.test(text.slice(0, 40)) ? 'nice' : section === 'nice' ? 'nice' : 'must';
    if (section === 'none' && !isBullet) continue; // intro prose, not a requirement
    const keywords = extractKeywords(text, vocabulary);
    if (!keywords.length && section === 'none') continue;
    out.push({ text, kind, keywords });
  }
  // Postings with no recognizable sections: fall back to keyword-bearing lines.
  if (!out.length) {
    for (const line of lines) {
      const keywords = extractKeywords(line, vocabulary);
      if (keywords.length) out.push({ text: line.replace(/^[-*•]\s*/, ''), kind: 'must', keywords });
    }
  }
  return out;
}
