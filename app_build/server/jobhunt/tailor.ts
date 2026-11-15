'use strict';

/**
 * Per-posting resume tailoring.
 *
 * Works only from the user's master resume. It reorders and selects real
 * bullets and skills by relevance to the posting's requirements, and can ask
 * an LLM to rephrase bullets in the posting's vocabulary. Every rewrite passes
 * the grounding check or the original bullet is kept. Requirements the resume
 * has no evidence for are reported as gaps, never filled in.
 */

import { checkGrounded } from './grounding';
import { buildVocabulary, extractRequirements } from './requirements';
import { matchesTerm } from './synonyms';
import { escapeHtml, numbersIn, stripDashes } from './text';
import type { GenerateText, JobPosting, MasterResume, Requirement, TailoringReport } from './types';

export interface Bullet {
  id: string;
  section: 'work' | 'project';
  parentIndex: number;
  text: string;
}

export interface TailoredResume {
  resume: MasterResume;
  markdown: string;
  html: string;
  report: TailoringReport;
  /** Bullets kept, highest relevance first, for the cover letter. */
  rankedBullets: (Bullet & { score: number })[];
  /** Bullets as printed (after rewrites), for page-fit trimming. */
  printed: { section: 'work' | 'project'; parentIndex: number; text: string; score: number; order: number }[];
}

export interface TailorOptions {
  generate?: GenerateText | null;
  maxBulletsPerRole?: number;
  minBulletsPerRole?: number;
  /** Rewrite at most this many top bullets with the LLM. */
  maxRewrites?: number;
}

export function masterText(master: MasterResume): string {
  const parts: string[] = [master.basics.name, master.basics.label ?? '', master.basics.summary ?? ''];
  for (const w of master.work ?? []) parts.push(w.name, w.position, w.location ?? '', w.summary ?? '', ...(w.highlights ?? []));
  for (const p of master.projects ?? []) parts.push(p.name, p.description ?? '', ...(p.highlights ?? []), ...(p.keywords ?? []));
  for (const e of master.education ?? []) parts.push(e.institution, e.area ?? '', e.studyType ?? '');
  for (const s of master.skills ?? []) parts.push(s.name, ...(s.keywords ?? []));
  for (const c of master.certificates ?? []) parts.push(c.name, c.issuer ?? '');
  return parts.filter(Boolean).join('\n');
}

export function flattenBullets(master: MasterResume): Bullet[] {
  const out: Bullet[] = [];
  (master.work ?? []).forEach((w, i) => (w.highlights ?? []).forEach((text, j) => out.push({ id: `w${i}.${j}`, section: 'work', parentIndex: i, text })));
  (master.projects ?? []).forEach((p, i) => (p.highlights ?? []).forEach((text, j) => out.push({ id: `p${i}.${j}`, section: 'project', parentIndex: i, text })));
  return out;
}

export function keywordWeights(requirements: Requirement[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const r of requirements) {
    for (const k of r.keywords) weights.set(k, Math.max(weights.get(k) ?? 0, r.kind === 'must' ? 2 : 1));
  }
  return weights;
}

export function scoreText(text: string, weights: Map<string, number>): number {
  let score = 0;
  for (const [k, w] of weights) if (matchesTerm(text, k)) score += w;
  return score;
}

/**
 * Evidence of impact, independent of keywords, so a strong bullet like
 * "Owned release validation for a platform supporting 4M+ menu boards" is not
 * dropped just because the posting never names its skills.
 */
export function impactScore(text: string): number {
  let s = 0;
  if (numbersIn(text).length) s += 0.5;
  if (/\d+(\.\d+)?\s?(%|percent|x\b)|\$\s?\d|\d+\s?(k|m|b)\+?\b|\bmillion|\bbillion|\bthousands?\b/i.test(text)) s += 0.75;
  if (/^(owned|led|designed|architected|built|launched|created|drove|founded|co-designed|spearheaded|established)\b/i.test(text.trim())) s += 0.5;
  return s;
}

function parseJsonObject(raw: string): Record<string, string> | null {
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function rewriteBullets(
  bullets: Bullet[],
  job: JobPosting,
  matched: string[],
  master: MasterResume,
  vocabulary: string[],
  generate: GenerateText,
): Promise<{ rewrites: Map<string, string>; rejected: TailoringReport['rejectedRewrites'] }> {
  const rewrites = new Map<string, string>();
  const rejected: TailoringReport['rejectedRewrites'] = [];
  if (!bullets.length) return { rewrites, rejected };
  const prompt = [
    `Rephrase these resume bullets for a "${job.title}" role at ${job.company}.`,
    `Use the posting's wording for these skills only where the bullet already shows them: ${matched.join(', ') || '(none)'}.`,
    'Rules: keep every fact exactly as given. Do not add numbers, tools, employers, titles, scope, or outcomes that are not in the bullet.',
    'Keep each bullet one sentence, under 30 words, starting with a strong verb. No em dashes.',
    'Return only a JSON object mapping each id to its rewritten bullet.',
    'Example of a good rewrite. Input {"x1":"Made automated tests for the checkout with Playwright, 240 flows"} gives {"x1":"Built Playwright automation covering 240 checkout flows"}. Same facts, same number, tighter wording.',
    'Example of a bad rewrite, never do this: adding "in CI/CD" or "reducing defects 30%" when the bullet does not say so.',
    'If a bullet cannot be improved without adding something, return it unchanged.',
    '',
    JSON.stringify(Object.fromEntries(bullets.map((b) => [b.id, b.text])), null, 2),
  ].join('\n');
  let raw = '';
  try {
    raw = await generate(prompt, { system: 'You edit resumes. You never invent experience.', maxTokens: 1200 });
  } catch (error) {
    rejected.push({ original: '(all)', rewritten: '', reason: `LLM call failed: ${(error as Error).message}` });
    return { rewrites, rejected };
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    rejected.push({ original: '(all)', rewritten: raw.slice(0, 200), reason: 'LLM did not return JSON' });
    return { rewrites, rejected };
  }
  const corpus = masterText(master);
  for (const b of bullets) {
    const candidate = typeof parsed[b.id] === 'string' ? stripDashes(parsed[b.id].trim()) : '';
    if (!candidate) continue;
    if (candidate.length > Math.max(220, b.text.length * 1.6)) {
      rejected.push({ original: b.text, rewritten: candidate, reason: 'rewrite is much longer than the original' });
      continue;
    }
    // Numbers must come from this exact bullet; names and skills from the master resume.
    const check = checkGrounded(candidate, b.text, [corpus], vocabulary);
    if (!check.ok) {
      rejected.push({ original: b.text, rewritten: candidate, reason: check.reason! });
      continue;
    }
    rewrites.set(b.id, candidate);
  }
  return { rewrites, rejected };
}

function displayCase(master: MasterResume, terms: string[]): string[] {
  const display = new Map<string, string>();
  for (const sk of master.skills ?? []) for (const k of [sk.name, ...(sk.keywords ?? [])]) display.set(k.toLowerCase(), k);
  for (const p of master.projects ?? []) for (const k of p.keywords ?? []) display.set(k.toLowerCase(), k);
  return terms.map((t) => display.get(t) ?? t);
}

/**
 * A 2-3 line summary aimed at this role. With an LLM it rephrases the master
 * summary (numbers only from the master summary, names and skills only from
 * the resume). Without one, it appends the matched skills in the resume's own
 * casing. Falls back to the master summary on any failed check.
 */
async function targetedSummary(
  master: MasterResume,
  job: JobPosting,
  matched: string[],
  vocabulary: string[],
  generate: GenerateText | null,
): Promise<{ text: string | null; rejected?: TailoringReport['rejectedRewrites'][number] }> {
  const base = master.basics.summary?.trim();
  if (!base) return { text: null };
  const skills = displayCase(master, matched.filter((k) => k.length > 2)).slice(0, 5);
  if (generate) {
    try {
      const raw = await generate(
        [
          `Rewrite this resume summary for a "${job.title}" role at ${job.company}. Two or three sentences, under 60 words.`,
          `Lead with the experience most relevant to the role. You may mention these skills because the resume shows them: ${skills.join(', ') || '(none)'}.`,
          'Keep every fact as stated. Do not add numbers, years, employers, titles, credentials, or skills. No em dashes. Return only the summary.',
          '',
          base,
        ].join('\n'),
        { system: 'You edit resumes. You never invent experience.', maxTokens: 300 },
      );
      const candidate = stripDashes(String(raw).trim().replace(/^["']|["']$/g, ''));
      const check = checkGrounded(candidate, base, [masterText(master)], vocabulary);
      if (candidate && check.ok && candidate.length < base.length * 1.6 + 80) return { text: candidate };
      return { text: base, rejected: { original: base, rewritten: candidate, reason: check.reason ?? 'summary too long' } };
    } catch (error) {
      return { text: base, rejected: { original: base, rewritten: '', reason: `LLM call failed: ${(error as Error).message}` } };
    }
  }
  if (skills.length >= 2) return { text: `${base.replace(/\s*$/, '')} Relevant to this role: ${skills.join(', ')}.` };
  return { text: base };
}

export async function tailorResume(master: MasterResume, job: JobPosting, options: TailorOptions = {}): Promise<TailoredResume> {
  const maxPerRole = options.maxBulletsPerRole ?? 5;
  const minPerRole = options.minBulletsPerRole ?? 2;
  const requirements = extractRequirements(job.descriptionText, master);
  const weights = keywordWeights(requirements);
  const corpus = masterText(master);
  const vocabulary = buildVocabulary(master);

  const allKeywords = [...weights.keys()];
  const matched = allKeywords.filter((k) => matchesTerm(corpus, k));
  const gaps = allKeywords.filter((k) => !matchesTerm(corpus, k));
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
  const matchedWeight = matched.reduce((a, k) => a + (weights.get(k) ?? 0), 0);
  const fitScore = totalWeight ? Math.round((matchedWeight / totalWeight) * 100) : 0;

  const bullets = flattenBullets(master).map((b, order) => ({ ...b, order, score: scoreText(b.text, weights) + impactScore(b.text) }));

  // Select per parent: highest score first, original order as tie-break.
  const selected = new Map<string, (typeof bullets)[number]>();
  const byParent = new Map<string, typeof bullets>();
  for (const b of bullets) {
    const key = `${b.section}:${b.parentIndex}`;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(b);
  }
  for (const group of byParent.values()) {
    const ranked = [...group].sort((a, b) => b.score - a.score || a.order - b.order);
    const relevant = ranked.filter((b) => b.score > 0).length;
    const keep = Math.min(ranked.length, maxPerRole, Math.max(minPerRole, relevant));
    for (const b of ranked.slice(0, keep)) selected.set(b.id, b);
  }

  const rankedBullets = [...selected.values()].sort((a, b) => b.score - a.score || a.order - b.order);

  let rewrites = new Map<string, string>();
  let rejectedRewrites: TailoringReport['rejectedRewrites'] = [];
  if (options.generate) {
    const targets = rankedBullets.filter((b) => b.score > 0).slice(0, options.maxRewrites ?? 8);
    ({ rewrites, rejected: rejectedRewrites } = await rewriteBullets(targets, job, matched, master, vocabulary, options.generate));
  }

  // Rebuild the resume. Roles keep their original (chronological) order.
  const resume: MasterResume = JSON.parse(JSON.stringify(master));
  const summary = await targetedSummary(master, job, matched, vocabulary, options.generate ?? null);
  if (summary.text) resume.basics.summary = summary.text;
  if (summary.rejected) rejectedRewrites.push(summary.rejected);
  const pick = (section: 'work' | 'project', i: number) =>
    rankedBullets
      .filter((b) => b.section === section && b.parentIndex === i)
      .map((b) => rewrites.get(b.id) ?? b.text);
  resume.work = (master.work ?? []).map((w, i) => ({ ...w, highlights: pick('work', i) }));
  resume.projects = (master.projects ?? [])
    .map((p, i) => ({ p: { ...p, highlights: pick('project', i) }, score: scoreText(masterText({ basics: { name: '' }, projects: [p] }), weights) }))
    .sort((a, b) => b.score - a.score)
    .map(({ p }) => p);
  resume.skills = (master.skills ?? [])
    .map((s) => {
      const keywords = [...(s.keywords ?? [])].sort((a, b) => scoreText(b, weights) - scoreText(a, weights));
      return { ...s, keywords, _score: scoreText([s.name, ...keywords].join(' '), weights) };
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...s }) => s);

  const report: TailoringReport = { requirements, matchedKeywords: matched, gaps, rejectedRewrites, fitScore };
  const printed = rankedBullets.map((b) => ({ section: b.section, parentIndex: b.parentIndex, text: rewrites.get(b.id) ?? b.text, score: b.score, order: b.order }));
  return { resume, markdown: renderResumeMarkdown(resume), html: renderResumeHtml(resume, job), report, rankedBullets, printed };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2024-05" -> "May 2024"; anything else passes through unchanged. */
export function formatDate(d?: string): string {
  const m = String(d ?? '').match(/^(\d{4})-(\d{1,2})/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(d ?? '');
}

function dates(start?: string, end?: string) {
  if (!start && !end) return '';
  return `${formatDate(start)} to ${end ? formatDate(end) : 'Present'}`;
}

function contactLine(r: MasterResume): string {
  const b = r.basics;
  const loc = [b.location?.city, b.location?.region].filter(Boolean).join(', ');
  return [b.email, b.phone, loc, b.url, ...(b.profiles ?? []).map((p) => p.url)].filter(Boolean).join(' | ');
}

export function renderResumeMarkdown(r: MasterResume): string {
  const lines: string[] = [`# ${r.basics.name}`];
  if (r.basics.label) lines.push(`**${r.basics.label}**`);
  const contact = contactLine(r);
  if (contact) lines.push(contact);
  if (r.basics.summary) lines.push('', '## Summary', r.basics.summary);
  if (r.skills?.length) {
    lines.push('', '## Skills');
    for (const s of r.skills) lines.push(`- **${s.name}:** ${(s.keywords ?? []).join(', ')}`);
  }
  if (r.work?.length) {
    lines.push('', '## Experience');
    for (const w of r.work) {
      lines.push('', `### ${w.position}, ${w.name}`, [w.location, dates(w.startDate, w.endDate)].filter(Boolean).join(' | '));
      for (const h of w.highlights ?? []) lines.push(`- ${h}`);
    }
  }
  const projects = (r.projects ?? []).filter((p) => p.highlights?.length);
  if (projects.length) {
    lines.push('', '## Projects');
    for (const p of projects) {
      lines.push('', `### ${p.name}`);
      for (const h of p.highlights ?? []) lines.push(`- ${h}`);
    }
  }
  if (r.education?.length) {
    lines.push('', '## Education');
    for (const e of r.education) lines.push(`- ${[e.studyType, e.area].filter(Boolean).join(', ')}${e.studyType || e.area ? ', ' : ''}${e.institution}${e.endDate ? ` (${formatDate(e.endDate)})` : ''}`);
  }
  if (r.certificates?.length) {
    lines.push('', '## Certifications');
    for (const c of r.certificates) lines.push(`- ${c.name}${c.issuer ? `, ${c.issuer}` : ''}${c.date ? ` (${c.date})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

const PRINT_CSS = `
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; max-width: 760px; margin: 32px auto; padding: 0 24px; font-size: 11pt; line-height: 1.4; }
  h1 { font-size: 20pt; margin: 0; } h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #999; margin: 18px 0 6px; }
  h3 { font-size: 11pt; margin: 10px 0 0; } .meta { color: #444; font-size: 10pt; } ul { margin: 4px 0 0 18px; padding: 0; } li { margin: 2px 0; }
  @media print { body { margin: 0; } @page { margin: 0.6in; } }
`;

export function renderResumeHtml(r: MasterResume, job?: JobPosting): string {
  const e = escapeHtml;
  const parts: string[] = [];
  parts.push(`<h1>${e(r.basics.name)}</h1>`);
  if (r.basics.label) parts.push(`<div><strong>${e(r.basics.label)}</strong></div>`);
  const contact = contactLine(r);
  if (contact) parts.push(`<div class="meta">${e(contact)}</div>`);
  if (r.basics.summary) parts.push(`<h2>Summary</h2><p>${e(r.basics.summary)}</p>`);
  if (r.skills?.length) parts.push(`<h2>Skills</h2><ul>${r.skills.map((s) => `<li><strong>${e(s.name)}:</strong> ${e((s.keywords ?? []).join(', '))}</li>`).join('')}</ul>`);
  if (r.work?.length) {
    parts.push('<h2>Experience</h2>');
    for (const w of r.work) {
      parts.push(`<h3>${e(w.position)}, ${e(w.name)}</h3><div class="meta">${e([w.location, dates(w.startDate, w.endDate)].filter(Boolean).join(' | '))}</div>`);
      if (w.highlights?.length) parts.push(`<ul>${w.highlights.map((h) => `<li>${e(h)}</li>`).join('')}</ul>`);
    }
  }
  const projects = (r.projects ?? []).filter((p) => p.highlights?.length);
  if (projects.length) {
    parts.push('<h2>Projects</h2>');
    for (const p of projects) parts.push(`<h3>${e(p.name)}</h3><ul>${(p.highlights ?? []).map((h) => `<li>${e(h)}</li>`).join('')}</ul>`);
  }
  if (r.education?.length) parts.push(`<h2>Education</h2><ul>${r.education.map((x) => `<li>${e([x.studyType, x.area].filter(Boolean).join(', '))}${x.studyType || x.area ? ', ' : ''}${e(x.institution)}${x.endDate ? ` (${e(formatDate(x.endDate))})` : ''}</li>`).join('')}</ul>`);
  if (r.certificates?.length) parts.push(`<h2>Certifications</h2><ul>${r.certificates.map((c) => `<li>${e(c.name)}${c.issuer ? `, ${e(c.issuer)}` : ''}</li>`).join('')}</ul>`);
  const title = job ? `${r.basics.name} - ${job.title}, ${job.company}` : r.basics.name;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title><style>${PRINT_CSS}</style></head><body>${parts.join('\n')}</body></html>\n`;
}

export { PRINT_CSS };
