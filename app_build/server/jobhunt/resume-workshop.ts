'use strict';

/**
 * Resume workshop: one posting, one resume, built by the person.
 *
 * It starts from the automatic tailoring and lets the person choose which
 * real lines go in, reword them, pick the summary, and hide skills. An agent
 * pass can research the company and suggest wording, but:
 *   - agent wording must pass the grounding check against the saved resume
 *     (no new numbers, tools, employers or credentials) or it is discarded;
 *   - agent wording is only a suggestion until the person accepts it;
 *   - the person's own edits are theirs to make; anything that looks like a
 *     new fact is pointed out, not blocked.
 *
 * Research uses the posting, the company's public job board feed, pages the
 * person gives it, and the person's own notes. It does not read Glassdoor,
 * LinkedIn or Indeed: those sites do not allow automated reading. It links
 * to them instead.
 */

import { fetchBoard, type WatchlistEntry } from './discovery';
import { checkGrounded } from './grounding';
import { parsePostingUrl } from './postings';
import { buildVocabulary, extractKeywords, extractRequirements } from './requirements';
import type { JobHuntStore } from './store';
import { matchesTerm } from './synonyms';
import { flattenBullets, formatDate, keywordWeights, masterText, renderResumeHtml, renderResumeMarkdown, rewriteBullets, scoreText, tailorResume, impactScore, type TailoredResume } from './tailor';
import { htmlToText, stripDashes } from './text';
import type { Application, ApplicationStatus, GenerateText, JobPosting, MasterResume } from './types';

type App = Application & { job: JobPosting };

export interface ResearchSource {
  kind: 'posting' | 'board' | 'page' | 'notes' | 'blocked' | 'failed';
  label: string;
  detail: string;
}

export interface Research {
  at: number;
  sources: ResearchSource[];
  /** Skill and tool words the sources use, most common first. */
  terms: { term: string; count: number; from: string[]; onResume: boolean }[];
  /** Other open roles at the company, from its public job board feed. */
  otherRoles: { title: string; url: string | null }[];
  /** Written by the model from the sources above. Null when no model is connected. */
  brief: string[] | null;
}

export interface WorkshopChoices {
  headline: string | null;
  summaryMode: 'master' | 'targeted' | 'custom';
  summaryText: string;
  /** Per resume line: in or out, and the person's own wording when they changed it. */
  bullets: Record<string, { on?: boolean; text?: string }>;
  /** Lines moved to the top of their job. */
  pinned: string[];
  /** Whole jobs or projects left off ("w2", "p0"). */
  rolesOff: string[];
  skillsOff: string[];
  /** The person's own research notes (for example, what they read on Glassdoor). */
  notes: string;
  /** Agent wording waiting for a yes or no. */
  suggestions: Record<string, string>;
  /** Agent wording the grounding check threw out, with the reason. */
  rejected: { id: string; text: string; reason: string }[];
  research: Research | null;
  savedAt: number | null;
}

export const EMPTY_CHOICES: WorkshopChoices = {
  headline: null, summaryMode: 'targeted', summaryText: '', bullets: {}, pinned: [], rolesOff: [], skillsOff: [], notes: '', suggestions: {}, rejected: [], research: null, savedAt: null,
};

const kvKey = (id: string) => `resume_ws_${id}`;
const ID = /^[wp]\d{1,2}\.\d{1,2}$/;
const ROLE = /^[wp]\d{1,2}$/;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? stripDashes(v.replace(/\r\n/g, '\n')).slice(0, max) : '');

export function loadChoices(store: JobHuntStore, id: string): WorkshopChoices {
  try {
    const v = JSON.parse(store.getKv(kvKey(id)) ?? 'null');
    return v && typeof v === 'object' ? { ...EMPTY_CHOICES, ...v } : { ...EMPTY_CHOICES };
  } catch {
    return { ...EMPTY_CHOICES };
  }
}

/** Keep only well-formed choices. Research, suggestions and the saved stamp are kept from what is stored. */
export function sanitizeChoices(input: unknown, stored: WorkshopChoices): WorkshopChoices {
  const i: any = input && typeof input === 'object' ? input : {};
  const bullets: WorkshopChoices['bullets'] = {};
  for (const [k, v] of Object.entries(i.bullets ?? {}).slice(0, 300)) {
    if (!ID.test(k) || !v || typeof v !== 'object') continue;
    const b: { on?: boolean; text?: string } = {};
    if (typeof (v as any).on === 'boolean') b.on = (v as any).on;
    const text = clean((v as any).text, 600).replace(/\n+/g, ' ').trim();
    if (text) b.text = text;
    if ('on' in b || b.text) bullets[k] = b;
  }
  const ids = (v: unknown, re: RegExp, max: number) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && re.test(x)))].slice(0, max) : []);
  const suggestions: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored.suggestions)) if (!(i.dropSuggestions ?? []).includes(k)) suggestions[k] = v;
  return {
    headline: clean(i.headline, 120).trim() || null,
    summaryMode: ['master', 'targeted', 'custom'].includes(i.summaryMode) ? i.summaryMode : 'targeted',
    summaryText: clean(i.summaryText, 1500).trim(),
    bullets, pinned: ids(i.pinned, ID, 60), rolesOff: ids(i.rolesOff, ROLE, 30),
    skillsOff: Array.isArray(i.skillsOff) ? [...new Set(i.skillsOff.filter((x: unknown) => typeof x === 'string').map((x: string) => x.slice(0, 60)))].slice(0, 120) as string[] : [],
    notes: clean(i.notes, 6000),
    suggestions, rejected: stored.rejected, research: stored.research, savedAt: stored.savedAt,
  };
}

export function saveChoices(store: JobHuntStore, id: string, choices: WorkshopChoices) {
  store.setKv(kvKey(id), JSON.stringify(choices));
}

// ── Building the resume ────────────────────────────────────────────────────

interface Line {
  id: string;
  section: 'work' | 'project';
  parentIndex: number;
  master: string;
  text: string;
  on: boolean;
  /** In by default, before any choice. */
  auto: boolean;
  score: number;
  order: number;
  hits: string[];
  edited: boolean;
  /** Why the person's wording looks like it adds a fact, or null. */
  flag: string | null;
  suggestion: string | null;
  pinned: boolean;
}

interface Draft {
  resume: MasterResume;
  lines: Line[];
  base: TailoredResume;
  keywords: { term: string; kind: 'must' | 'nice'; onResume: boolean; inDraft: boolean }[];
  targetedSummary: string | null;
}

/** The posting's keywords and every resume line with its state under these choices. */
export async function buildDraft(master: MasterResume, job: JobPosting, choices: WorkshopChoices): Promise<Draft> {
  // No model here: the starting point is the deterministic selection.
  const base = await tailorResume(master, job, { generate: null });
  const requirements = base.report.requirements;
  const weights = keywordWeights(requirements);
  const corpus = masterText(master);
  const vocabulary = buildVocabulary(master);
  const auto = new Set(base.rankedBullets.map((b) => b.id));
  const terms = [...weights.keys()];

  const lines: Line[] = flattenBullets(master).map((b, order) => {
    const c = choices.bullets[b.id] ?? {};
    const text = c.text && c.text !== b.text ? c.text : b.text;
    const edited = text !== b.text;
    const check = edited ? checkGrounded(text, b.text, [corpus], vocabulary) : { ok: true as const };
    return {
      id: b.id, section: b.section, parentIndex: b.parentIndex, master: b.text, text,
      on: typeof c.on === 'boolean' ? c.on : auto.has(b.id), auto: auto.has(b.id),
      score: scoreText(b.text, weights) + impactScore(b.text), order,
      hits: terms.filter((t) => matchesTerm(text, t)), edited,
      flag: check.ok ? null : ((check as { reason?: string }).reason ?? 'adds something not on your saved resume').replace('is not in the source', 'is not in your original line').replace('or the posting', ''),
      suggestion: choices.suggestions[b.id] && choices.suggestions[b.id] !== text ? choices.suggestions[b.id] : null,
      pinned: choices.pinned.includes(b.id),
    };
  });

  const resume: MasterResume = JSON.parse(JSON.stringify(master));
  const pick = (section: 'work' | 'project', i: number) => lines
    .filter((l) => l.section === section && l.parentIndex === i && l.on)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || a.order - b.order)
    .map((l) => l.text);
  resume.work = (master.work ?? []).map((w, i) => ({ ...w, highlights: pick('work', i) })).filter((_, i) => !choices.rolesOff.includes(`w${i}`));
  if (!resume.work.length) resume.work = (master.work ?? []).slice(0, 1).map((w) => ({ ...w, highlights: pick('work', 0) }));
  resume.projects = (master.projects ?? []).map((p, i) => ({ ...p, highlights: pick('project', i) })).filter((_, i) => !choices.rolesOff.includes(`p${i}`));
  const off = new Set(choices.skillsOff.map((s) => s.toLowerCase()));
  resume.skills = (base.resume.skills ?? []).map((g) => ({ ...g, keywords: (g.keywords ?? []).filter((k) => !off.has(k.toLowerCase())) })).filter((g) => g.keywords.length);
  const targeted = base.resume.basics.summary ?? null;
  const summary = choices.summaryMode === 'custom' && choices.summaryText ? choices.summaryText : choices.summaryMode === 'master' ? master.basics.summary : targeted;
  resume.basics = { ...resume.basics, summary: summary || undefined, label: choices.headline ?? master.basics.label };

  const draftText = masterText(resume);
  const kind = new Map<string, 'must' | 'nice'>();
  for (const r of requirements) for (const k of r.keywords) if (kind.get(k) !== 'must') kind.set(k, r.kind);
  const keywords = terms.map((term) => ({ term, kind: kind.get(term) ?? 'must', onResume: matchesTerm(corpus, term), inDraft: matchesTerm(draftText, term) }))
    .sort((a, b) => Number(b.kind === 'must') - Number(a.kind === 'must') || Number(b.onResume) - Number(a.onResume) || a.term.localeCompare(b.term));
  return { resume, lines, base, keywords, targetedSummary: targeted };
}

// ── What the screen shows ──────────────────────────────────────────────────

export interface WorkshopView {
  id: string;
  company: string;
  title: string;
  url: string;
  status: ApplicationStatus;
  savedAt: number | null;
  /** True when there are choices newer than the saved version. */
  keywords: Draft['keywords'];
  coverage: { inDraft: number; onResume: number; total: number; mustMissing: string[] };
  gaps: string[];
  headline: { value: string; master: string };
  summary: { mode: WorkshopChoices['summaryMode']; master: string; targeted: string; custom: string; flag: string | null };
  roles: { key: string; section: 'work' | 'project'; name: string; position: string; dates: string; on: boolean; lines: Omit<Line, 'section' | 'parentIndex' | 'order'>[] }[];
  skills: { group: string; items: { name: string; on: boolean; hit: boolean }[] }[];
  notes: string;
  research: Research | null;
  rejected: WorkshopChoices['rejected'];
  links: { label: string; url: string; note: string }[];
  words: number;
  lineCount: number;
  previewHtml: string;
  choices: WorkshopChoices;
}

const searchUrl = (base: string, q: string) => `${base}${encodeURIComponent(q)}`;

export function researchLinks(job: JobPosting): WorkshopView['links'] {
  return [
    { label: 'Glassdoor', url: searchUrl('https://www.glassdoor.com/Search/results.htm?keyword=', job.company), note: 'Reviews and interview reports. Read it yourself and paste what matters into your notes.' },
    { label: 'LinkedIn company page', url: searchUrl('https://www.linkedin.com/search/results/companies/?keywords=', job.company), note: 'Who works there and how they describe the team.' },
    { label: 'Levels.fyi', url: searchUrl('https://www.levels.fyi/companies/', job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')), note: 'Pay reports, where the company is listed.' },
    { label: 'Web search', url: searchUrl('https://duckduckgo.com/?q=', `"${job.company}" engineering blog QA testing`), note: 'Engineering blog, news, how they talk about quality.' },
  ];
}

export async function workshopView(store: JobHuntStore, app: App, master: MasterResume): Promise<WorkshopView> {
  const choices = loadChoices(store, app.id);
  const d = await buildDraft(master, app.job, choices);
  const corpus = masterText(master);
  const vocabulary = buildVocabulary(master);
  const hitTerms = d.keywords.map((k) => k.term);
  const span = (a?: string, b?: string) => [formatDate(a), a ? formatDate(b) || 'Present' : ''].filter(Boolean).join(' to ');
  const roles: WorkshopView['roles'] = [
    ...(master.work ?? []).map((w, i) => ({ key: `w${i}`, section: 'work' as const, name: w.name, position: w.position, dates: span(w.startDate, w.endDate) })),
    ...(master.projects ?? []).map((p, i) => ({ key: `p${i}`, section: 'project' as const, name: p.name, position: 'Project', dates: '' })),
  ].map((r) => ({
    ...r, on: !choices.rolesOff.includes(r.key),
    lines: d.lines.filter((l) => `${l.section === 'work' ? 'w' : 'p'}${l.parentIndex}` === r.key)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || a.order - b.order)
      .map(({ section: _s, parentIndex: _p, order: _o, ...rest }) => rest),
  })).filter((r) => r.lines.length || r.section === 'work');
  const off = new Set(choices.skillsOff.map((s) => s.toLowerCase()));
  const customFlag = choices.summaryMode === 'custom' && choices.summaryText
    ? checkGrounded(choices.summaryText, `${master.basics.summary ?? ''}\n${corpus}`, [corpus], vocabulary) : { ok: true as const };
  const text = renderResumeMarkdown(d.resume);
  return {
    id: app.id, company: app.job.company, title: app.job.title, url: app.job.url ?? '', status: app.status, savedAt: choices.savedAt,
    keywords: d.keywords,
    coverage: {
      inDraft: d.keywords.filter((k) => k.inDraft).length, onResume: d.keywords.filter((k) => k.onResume).length, total: d.keywords.length,
      mustMissing: d.keywords.filter((k) => k.kind === 'must' && k.onResume && !k.inDraft).map((k) => k.term),
    },
    gaps: d.keywords.filter((k) => !k.onResume).map((k) => k.term),
    headline: { value: choices.headline ?? master.basics.label ?? '', master: master.basics.label ?? '' },
    summary: { mode: choices.summaryMode, master: master.basics.summary ?? '', targeted: d.targetedSummary ?? '', custom: choices.summaryText, flag: customFlag.ok ? null : (customFlag as { reason?: string }).reason ?? null },
    roles,
    skills: (d.base.resume.skills ?? []).map((g) => ({ group: g.name, items: (g.keywords ?? []).map((k) => ({ name: k, on: !off.has(k.toLowerCase()), hit: hitTerms.some((t) => matchesTerm(k, t)) })) })),
    notes: choices.notes, research: choices.research, rejected: choices.rejected, links: researchLinks(app.job),
    words: text.replace(/[#*|-]/g, ' ').split(/\s+/).filter(Boolean).length, lineCount: d.lines.filter((l) => l.on).length,
    previewHtml: renderResumeHtml(d.resume, app.job), choices,
  };
}

// ── Agent wording ──────────────────────────────────────────────────────────

/**
 * Ask the model to reword lines in the posting's vocabulary. Every result is
 * checked against the saved resume; anything that adds a fact is thrown out
 * and listed with the reason. Results are suggestions only.
 */
export async function suggestWording(store: JobHuntStore, app: App, master: MasterResume, generate: GenerateText, ids?: string[]): Promise<{ accepted: number; rejected: number }> {
  const choices = loadChoices(store, app.id);
  const d = await buildDraft(master, app.job, choices);
  const wanted = (ids?.length ? d.lines.filter((l) => ids.includes(l.id)) : d.lines.filter((l) => l.on && l.score > 0).sort((a, b) => b.score - a.score).slice(0, 8)).slice(0, 12);
  if (!wanted.length) return { accepted: 0, rejected: 0 };
  // Research words count only when the resume already shows them.
  const extra = (choices.research?.terms ?? []).filter((t) => t.onResume).map((t) => t.term);
  const matched = [...new Set([...d.keywords.filter((k) => k.onResume).map((k) => k.term), ...extra])];
  const { rewrites, rejected } = await rewriteBullets(wanted.map((l) => ({ id: l.id, section: l.section, parentIndex: l.parentIndex, text: l.master })), app.job, matched, master, buildVocabulary(master), generate);
  const next = { ...choices, suggestions: { ...choices.suggestions } };
  for (const [id, text] of rewrites) if (text !== d.lines.find((l) => l.id === id)?.master) next.suggestions[id] = text;
  next.rejected = rejected.map((r) => ({ id: wanted.find((l) => l.master === r.original)?.id ?? '', text: r.rewritten, reason: r.reason })).slice(0, 12);
  saveChoices(store, app.id, next);
  return { accepted: rewrites.size, rejected: rejected.length };
}

// ── Company research ───────────────────────────────────────────────────────

const NO_ROBOTS: { host: RegExp; name: string }[] = [
  { host: /(^|\.)glassdoor\.[a-z.]+$/, name: 'Glassdoor' }, { host: /(^|\.)linkedin\.com$/, name: 'LinkedIn' }, { host: /(^|\.)indeed\.com$/, name: 'Indeed' },
  { host: /(^|\.)(facebook|instagram)\.com$/, name: 'Facebook and Instagram' }, { host: /(^|\.)(x|twitter)\.com$/, name: 'X' }, { host: /(^|\.)teamblind\.com$/, name: 'Blind' },
];
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i;

/** Why a page will not be read, or null when it is fine to fetch. */
export function pageRefusal(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return 'That is not a web address.';
  }
  if (url.protocol !== 'https:') return 'Only https pages are read.';
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || !host.includes('.')) return 'Only public web pages are read.';
  const site = NO_ROBOTS.find((s) => s.host.test(host));
  if (site) return `${site.name} does not allow automated reading, so the app will not fetch it. Open it yourself and paste what matters into your notes.`;
  return null;
}

async function readPage(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: { Accept: 'text/html,text/plain', 'User-Agent': 'job-search-assistant (personal use)' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/(html|plain)|application\/xhtml/i.test(type)) throw new Error('not a text page');
  const html = (await res.text()).slice(0, 600_000);
  return htmlToText(html.replace(/<(script|style|nav|footer|noscript)[\s\S]*?<\/\1>/gi, ' ')).slice(0, 30_000);
}

function boardEntry(job: JobPosting): WatchlistEntry | null {
  const slug = job.sourceId?.includes(':') ? job.sourceId.split(':')[0] : null;
  if (slug && (job.source === 'greenhouse' || job.source === 'lever' || job.source === 'ashby')) return { ats: job.source, slug, name: job.company };
  const parsed = job.url ? parsePostingUrl(job.url) : null;
  if (!parsed) return null;
  return { ats: parsed.source, slug: parsed.source === 'greenhouse' ? parsed.board : parsed.source === 'lever' ? parsed.company : parsed.org, name: job.company };
}

const RELATED = /\b(qa|quality|test|tester|sdet|automation|engineer|developer|devops|release|reliability)\b/i;

export interface ResearchOptions {
  urls?: string[];
  fetchImpl?: typeof fetch;
  generate?: GenerateText | null;
  now?: number;
}

/**
 * Gather the company's own language from sources that may be read: the
 * posting, its public job board feed, pages the person names, and their notes.
 */
export async function researchCompany(store: JobHuntStore, app: App, master: MasterResume, o: ResearchOptions = {}): Promise<Research> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const choices = loadChoices(store, app.id);
  const vocabulary = buildVocabulary(master);
  const corpus = masterText(master);
  const sources: ResearchSource[] = [];
  const counts = new Map<string, { count: number; from: Set<string> }>();
  const texts: string[] = [];
  const add = (label: string, text: string) => {
    texts.push(text);
    const seen = new Set<string>();
    for (const line of text.split('\n')) for (const k of extractKeywords(line, vocabulary)) seen.add(k);
    for (const k of seen) {
      const c = counts.get(k) ?? { count: 0, from: new Set<string>() };
      c.count++;
      c.from.add(label);
      counts.set(k, c);
    }
    return seen.size;
  };

  const reqs = extractRequirements(app.job.descriptionText, master);
  add('This posting', app.job.descriptionText);
  sources.push({ kind: 'posting', label: 'This posting', detail: `${reqs.length} requirement lines read.` });

  const otherRoles: Research['otherRoles'] = [];
  const entry = boardEntry(app.job);
  if (entry) {
    try {
      const all = await fetchBoard(entry, fetchImpl);
      const related = all.filter((p) => p.title !== app.job.title && RELATED.test(p.title)).slice(0, 12);
      for (const p of related) {
        add('Their other open roles', p.descriptionText);
        otherRoles.push({ title: p.title, url: p.url ?? null });
      }
      sources.push({ kind: 'board', label: `${app.job.company} job board (public feed)`, detail: `${all.length} open roles, ${related.length} related ones read.` });
    } catch (error) {
      sources.push({ kind: 'failed', label: `${app.job.company} job board`, detail: `Could not be read: ${(error as Error).message.slice(0, 80)}` });
    }
  } else {
    sources.push({ kind: 'failed', label: `${app.job.company} job board`, detail: 'This posting is not from a job board with a public feed (Greenhouse, Lever, Ashby), so other roles were not read.' });
  }

  for (const raw of (o.urls ?? []).map((u) => String(u).trim()).filter(Boolean).slice(0, 4)) {
    const refusal = pageRefusal(raw);
    if (refusal) {
      sources.push({ kind: 'blocked', label: raw.slice(0, 120), detail: refusal });
      continue;
    }
    try {
      const text = await readPage(raw, fetchImpl);
      const n = add(new URL(raw).hostname, text);
      sources.push({ kind: 'page', label: raw.slice(0, 120), detail: `Read. ${n} skill and tool words found.` });
    } catch (error) {
      sources.push({ kind: 'failed', label: raw.slice(0, 120), detail: `Could not be read: ${(error as Error).message.slice(0, 80)}` });
    }
  }

  if (choices.notes.trim()) {
    const n = add('Your notes', choices.notes);
    sources.push({ kind: 'notes', label: 'Your notes', detail: `${n} skill and tool words found.` });
  }

  let brief: string[] | null = null;
  if (o.generate) {
    try {
      const raw = await o.generate(
        [
          `A job seeker is applying for "${app.job.title}" at ${app.job.company}. From the source text below, list what this employer appears to care about most for this role.`,
          'Return only a JSON array of 3 to 5 short strings. Each must be supported by the source text. Do not guess about pay, culture or interview process. No em dashes.',
          '', '--- POSTING ---', app.job.descriptionText.slice(0, 5000),
          otherRoles.length ? `\n--- OTHER OPEN ROLES ---\n${otherRoles.map((r) => r.title).join('\n')}` : '',
          texts.length > 1 ? `\n--- OTHER SOURCES (excerpts) ---\n${texts.slice(1).map((t) => t.slice(0, 1500)).join('\n...\n').slice(0, 6000)}` : '',
        ].join('\n'),
        { system: 'You summarize job postings for a job seeker. You only state what the text supports.', maxTokens: 500 },
      );
      const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
      if (Array.isArray(parsed)) brief = parsed.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5).map((x: string) => stripDashes(x.trim()).slice(0, 220));
    } catch {
      brief = null; // the counted words above stand on their own
    }
  }

  const research: Research = {
    at: o.now ?? Date.now(), sources,
    terms: [...counts].map(([term, c]) => ({ term, count: c.count, from: [...c.from], onResume: matchesTerm(corpus, term) }))
      .sort((a, b) => b.count - a.count || Number(b.onResume) - Number(a.onResume) || a.term.localeCompare(b.term)).slice(0, 40),
    otherRoles: otherRoles.slice(0, 12), brief: brief?.length ? brief : null,
  };
  saveChoices(store, app.id, { ...loadChoices(store, app.id), research });
  return research;
}

// ── What has worked for this person ────────────────────────────────────────

const POSITIVE: ApplicationStatus[] = ['assessment', 'screening', 'interviewing', 'offer', 'accepted'];
const SENT: ApplicationStatus[] = ['applied', 'acknowledged', 'bounced', 'rejected', 'ghosted', ...POSITIVE];

/**
 * Callback rate by posting keyword, from the person's own applications.
 * This is the only "what wins" data the app has. Small counts are noise, so
 * a keyword needs at least minSent applications to be listed.
 */
export function keywordOutcomes(store: JobHuntStore, master: MasterResume, minSent = 3): { sent: number; rows: { term: string; sent: number; callbacks: number; rate: number }[] } {
  const apps = store.listApplications().map((a) => ({ a, reached: new Set(store.history(a.id).map((h) => h.toStatus)) })).filter(({ reached }) => SENT.some((s) => reached.has(s)));
  const tally = new Map<string, { sent: number; callbacks: number }>();
  for (const { a, reached } of apps) {
    const won = POSITIVE.some((s) => reached.has(s));
    const terms = new Set(extractRequirements(a.job.descriptionText, master).flatMap((r) => r.keywords));
    for (const t of terms) {
      const c = tally.get(t) ?? { sent: 0, callbacks: 0 };
      c.sent++;
      if (won) c.callbacks++;
      tally.set(t, c);
    }
  }
  const rows = [...tally].filter(([, c]) => c.sent >= minSent).map(([term, c]) => ({ term, ...c, rate: Math.round((c.callbacks / c.sent) * 100) }))
    .sort((a, b) => b.rate - a.rate || b.sent - a.sent || a.term.localeCompare(b.term)).slice(0, 12);
  return { sent: apps.length, rows };
}
