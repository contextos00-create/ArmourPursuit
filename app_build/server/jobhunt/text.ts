'use strict';

/** Small dependency-free text helpers shared by ingestion and tailoring. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '*', hellip: '...',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Convert posting HTML to plain text, keeping list items and headings on their own lines. */
export function htmlToText(html: string): string {
  let s = String(html || '');
  // Greenhouse returns entity-escaped HTML; decode once first if it looks escaped.
  if (/&lt;\s*[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|li|section|tr)\s*>/gi, '\n')
    .replace(/<\s*h[1-6][^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // Strip zero-width and bidi control characters (hidden prompt-injection carriers).
  s = decodeEntities(s).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Lowercase, keep characters that matter in tech terms (c++, c#, node.js). */
export function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
}

/** True if `term` occurs in `haystack` as a whole word/phrase (case-insensitive). */
export function containsTerm(haystack: string, term: string): boolean {
  const t = normalizeTerm(term);
  if (!t) return false;
  const h = ` ${normalizeTerm(haystack)} `;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`).test(h);
}

export function numbersIn(s: string): string[] {
  return (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
}

/** Remove em and en dashes from generated prose (user style rule). */
export function stripDashes(s: string): string {
  return s.replace(/\s*[—]\s*/g, ', ').replace(/\s[–]\s/g, ', ').replace(/–/g, '-');
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Folder name for an application's generated documents. */
export function documentDirName(job: { company: string; title: string }, applicationId: string): string {
  return `${slug(job.company)}-${slug(job.title)}-${applicationId.slice(0, 8)}`;
}
