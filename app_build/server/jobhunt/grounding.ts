'use strict';

/**
 * Guards that keep generated text honest. A generated sentence or bullet may
 * rephrase the user's real experience but may not add facts: every number must
 * come from its source, and every named thing (tool, company, credential) must
 * already appear in the master resume or, for cover letters, the posting.
 */

import { matchesTerm } from './synonyms';
import { containsTerm, numbersIn, normalizeTerm } from './text';

export interface GroundingResult {
  ok: boolean;
  reason?: string;
}

const COMMON_CAPITALIZED = new Set([
  'i', 'i\'m', 'i\'ve', 'i\'d', 'my', 'the', 'a', 'an', 'in', 'at', 'as', 'for', 'and', 'with', 'this', 'that', 'these', 'it', 'we', 'our',
  'dear', 'hiring', 'manager', 'team', 'sincerely', 'regards', 'best', 'thank', 'thanks', 'you', 'your', 'led', 'built', 'shipped',
  'designed', 'managed', 'drove', 'created', 'developed', 'improved', 'reduced', 'increased', 'launched', 'owned', 'delivered', 'when',
  'while', 'by', 'from', 'to', 'on', 'of', 'over', 'across', 'after', 'before', 'during', 'since', 'today', 'recently', 'currently',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/** Capitalized words that are not just the first word of a sentence. */
export function namedTerms(text: string): string[] {
  const terms: string[] = [];
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '');
      if (!clean) return;
      const lower = clean.toLowerCase();
      if (COMMON_CAPITALIZED.has(lower)) return;
      const looksNamed = /^[A-Z]/.test(clean) || /[A-Z].*[A-Z]/.test(clean) || /[+#.]/.test(clean.slice(1));
      if (!looksNamed) return;
      if (i === 0 && /^[A-Z][a-z]+$/.test(clean)) return; // ordinary sentence start
      terms.push(clean);
    });
  }
  return terms;
}

/**
 * @param candidate     generated text
 * @param numberSource  text whose numbers the candidate may use
 * @param termSources   texts whose named terms / vocabulary the candidate may use
 * @param vocabulary    known skill terms; any that appear in the candidate must be in termSources
 */
export function checkGrounded(candidate: string, numberSource: string, termSources: string[], vocabulary: string[] = []): GroundingResult {
  const allowedNumbers = new Set(numbersIn(numberSource));
  for (const n of numbersIn(candidate)) {
    if (!allowedNumbers.has(n)) return { ok: false, reason: `number "${n}" is not in the source` };
  }
  const corpus = termSources.join('\n');
  for (const term of namedTerms(candidate)) {
    if (!matchesTerm(corpus, term)) return { ok: false, reason: `"${term}" does not appear in your resume or the posting` };
  }
  for (const term of vocabulary) {
    if (term.length < 2) continue;
    if (containsTerm(candidate, term) && !matchesTerm(corpus, term)) {
      return { ok: false, reason: `skill "${term}" is not evidenced in your resume` };
    }
  }
  if (/[—]/.test(candidate)) return { ok: false, reason: 'contains an em dash' };
  return { ok: true };
}

export function wordSet(s: string): Set<string> {
  return new Set(normalizeTerm(s).split(' ').filter((w) => w.length > 2));
}
