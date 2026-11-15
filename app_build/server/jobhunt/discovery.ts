'use strict';

/**
 * Discovery: poll a watchlist of company job boards (Greenhouse, Lever, Ashby
 * public JSON APIs) and, optionally, Adzuna search, then keep only roles whose
 * titles match, drop ones already seen, score the rest, and admit the best up
 * to a daily target. Nothing below the 65 fit floor is admitted to hit a number.
 */

import { learnedBoost } from './insights';
import { scoreFit, type FitScore, type SearchPreferences } from './scoring';
import { htmlToText, normalizeTerm } from './text';
import type { JobPosting, MasterResume, NewJobPosting } from './types';
import type { JobHuntStore } from './store';

export interface WatchlistEntry {
  ats: 'greenhouse' | 'lever' | 'ashby';
  /** Board slug as it appears in the board URL, e.g. "acme" in boards.greenhouse.io/acme. */
  slug: string;
  name?: string;
}

export interface DiscoveryPreferences extends SearchPreferences {
  watchlist?: WatchlistEntry[];
  /** Title must contain one of these. Defaults to targetTitles, then a QA set. */
  titleKeywords?: string[];
  /** Titles containing any of these are skipped. */
  excludeTitleKeywords?: string[];
  dailyTarget?: number;
  /** Postings scoring at least this get an immediate "top match" text and may exceed the daily target by hotExtra. Default 85. */
  hotScore?: number;
  hotExtra?: number;
  adzuna?: { country?: string; what: string[]; where?: string | string[]; maxDaysOld?: number };
}

// Software QA titles. Bare "quality" and "test" are too broad: big boards are
// full of food-safety, manufacturing and flight-test roles.
const DEFAULT_TITLE_KEYWORDS = [
  'qa', 'quality assurance', 'quality engineer', 'quality analyst', 'software quality', 'sdet', 'engineer in test',
  'test engineer', 'test automation', 'automation engineer', 'automation tester', 'software tester', 'tester', 'test analyst',
];
const DEFAULT_EXCLUDES = [
  'intern', 'internship', 'director', 'vp', 'vice president', 'principal', 'staff', 'manager', 'head of', 'food', 'safety',
  'forklift', 'hardware', 'manufacturing', 'mechanical', 'supplier', 'field', 'flight', 'crash', 'ads quality', 'search quality',
  'product quality', 'proctor', 'auto body', 'automotive', 'line lead', 'electrical', 'clinical', 'lab',
  // Hardware and physical test roles.
  'propulsion', 'turbomachinery', 'maritime', 'fuel', 'powertrain', 'powerplant', 'rf', 'emi', 'emc', 'rocket', 'missile', 'missiles',
  'vehicle', 'aircraft', 'avionics', 'structures', 'thermal', 'battery', 'assembly', 'mechanical', 'chemical', 'materials', 'it asset',
];

function titleCase(slug: string) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url.replace(/app_key=[^&]+/, 'app_key=***')} returned ${res.status}`);
  return res.json();
}

export async function fetchBoard(entry: WatchlistEntry, fetchImpl: typeof fetch = fetch): Promise<NewJobPosting[]> {
  const company = entry.name ?? titleCase(entry.slug);
  const slug = encodeURIComponent(entry.slug);
  if (entry.ats === 'greenhouse') {
    const json = await getJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return (json.jobs ?? []).map((j: any) => ({
      source: 'greenhouse', sourceId: `${entry.slug}:${j.id}`, url: j.absolute_url ?? null, company,
      title: j.title, location: j.location?.name ?? null, descriptionText: htmlToText(j.content ?? ''),
    }));
  }
  if (entry.ats === 'lever') {
    const json = await getJson(fetchImpl, `https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(json) ? json : []).map((j: any) => ({
      source: 'lever', sourceId: `${entry.slug}:${j.id}`, url: j.hostedUrl ?? null, company, title: j.text,
      location: j.categories?.location ?? null,
      descriptionText: [j.descriptionPlain ?? '', ...(j.lists ?? []).map((l: any) => `${l.text}:\n${htmlToText(l.content ?? '')}`), j.additionalPlain ?? ''].filter(Boolean).join('\n\n'),
    }));
  }
  const json = await getJson(fetchImpl, `https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (json.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => ({
    source: 'ashby', sourceId: `${entry.slug}:${j.id}`, url: j.jobUrl ?? null, company, title: j.title,
    location: j.location ?? null, descriptionText: j.descriptionPlain || htmlToText(j.descriptionHtml ?? ''),
  }));
}

/** Adzuna search (https://developer.adzuna.com). Needs ADZUNA_APP_ID and ADZUNA_APP_KEY. Descriptions are snippets. */
export async function fetchAdzuna(
  cfg: NonNullable<DiscoveryPreferences['adzuna']>,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NewJobPosting[]> {
  const id = env.ADZUNA_APP_ID?.trim();
  const key = env.ADZUNA_APP_KEY?.trim();
  if (!id || !key) return [];
  const out: NewJobPosting[] = [];
  const wheres = Array.isArray(cfg.where) ? cfg.where : [cfg.where ?? ''];
  for (const what of cfg.what) for (const where of wheres) {
    const q = new URLSearchParams({ app_id: id, app_key: key, what, results_per_page: '50', max_days_old: String(cfg.maxDaysOld ?? 3), 'content-type': 'application/json' });
    if (where) q.set('where', where);
    const json = await getJson(fetchImpl, `https://api.adzuna.com/v1/api/jobs/${cfg.country ?? 'us'}/search/1?${q}`);
    for (const r of json.results ?? []) {
      const pay = r.salary_min && r.salary_max ? `\n$${Math.round(r.salary_min)} - $${Math.round(r.salary_max)}` : '';
      out.push({
        source: 'adzuna', sourceId: String(r.id), url: r.redirect_url ?? null, company: r.company?.display_name ?? 'Unknown',
        title: r.title?.replace(/<[^>]+>/g, '') ?? '', location: r.location?.display_name ?? null,
        descriptionText: `${htmlToText(r.description ?? '')}${pay}`,
      });
    }
  }
  return out;
}

export function titleAllowed(title: string, prefs: DiscoveryPreferences): boolean {
  const t = ` ${normalizeTerm(title).replace(/[/,()-]+/g, " ").replace(/\s+/g, " ")} `;
  const include = (prefs.titleKeywords?.length ? prefs.titleKeywords : prefs.targetTitles?.length ? prefs.targetTitles : DEFAULT_TITLE_KEYWORDS).map(normalizeTerm);
  const exclude = (prefs.excludeTitleKeywords ?? DEFAULT_EXCLUDES).map(normalizeTerm);
  if (exclude.some((x) => t.includes(` ${x} `))) return false;
  return include.some((x) => t.includes(` ${x} `) || t.includes(` ${x}s `));
}

export function canonicalKey(p: { company: string; title: string; location?: string | null }): string {
  const loc = normalizeTerm(p.location ?? '').split(/[ ,]/)[0] || 'any';
  return [normalizeTerm(p.company).replace(/\b(inc|llc|ltd|corp)\b/g, '').trim(), normalizeTerm(p.title).replace(/\b(sr|senior)\b/g, 'senior'), loc].join('|');
}

export interface DiscoveryResult {
  fetched: number;
  titleMatched: number;
  fresh: number;
  admitted: { posting: NewJobPosting; fit: FitScore; boost?: number }[];
  filteredOut: number;
  deferred: number;
  quotaLeft: number;
  errors: string[];
}

function dayKey(now: number) {
  return `discover_admitted_${new Date(now).toISOString().slice(0, 10)}`;
}

/**
 * Find and rank new postings. Returns the ones to admit; the caller adds them
 * (which texts and auto-tailors). Filtered-out postings are stored without an
 * application so they are not reconsidered.
 */
export async function discover(
  store: JobHuntStore,
  master: MasterResume,
  prefs: DiscoveryPreferences,
  options: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const result: DiscoveryResult = { fetched: 0, titleMatched: 0, fresh: 0, admitted: [], filteredOut: 0, deferred: 0, quotaLeft: 0, errors: [] };
  const all: NewJobPosting[] = [];
  for (const entry of prefs.watchlist ?? []) {
    try {
      all.push(...(await fetchBoard(entry, fetchImpl)));
    } catch (error) {
      result.errors.push(`${entry.ats}/${entry.slug}: ${(error as Error).message}`);
    }
  }
  if (prefs.adzuna?.what?.length) {
    try {
      all.push(...(await fetchAdzuna(prefs.adzuna, options.env, fetchImpl)));
    } catch (error) {
      result.errors.push(`adzuna: ${(error as Error).message}`);
    }
  }
  result.fetched = all.length;

  const seenKeys = new Set(store.allJobs().map(canonicalKey));
  const batchKeys = new Set<string>();
  const scored: { posting: NewJobPosting; fit: FitScore; boost: number }[] = [];
  for (const p of all) {
    if (!p.title || !titleAllowed(p.title, prefs)) continue;
    result.titleMatched++;
    if (p.sourceId && store.findJobBySource(p.source ?? 'manual', p.sourceId)) continue;
    const key = canonicalKey(p);
    if (seenKeys.has(key) || batchKeys.has(key)) continue;
    batchKeys.add(key);
    result.fresh++;
    const asJob: JobPosting = { id: '', source: p.source ?? 'manual', sourceId: p.sourceId ?? null, url: p.url ?? null, company: p.company, title: p.title, location: p.location ?? null, descriptionText: p.descriptionText, createdAt: now };
    const fit = scoreFit(master, asJob, prefs, new Date(now));
    // Ranking only: nudge toward groups that actually get callbacks (off until enough history).
    const { delta, reasons } = fit.route === 'filtered_out' ? { delta: 0, reasons: [] } : learnedBoost(store, { ...asJob, fitScore: fit.score });
    if (delta) fit.rationale.push(`Ranking ${delta > 0 ? '+' : ''}${delta} from results so far (${reasons.join('; ')})`);
    scored.push({ posting: p, fit, boost: delta });
  }

  for (const s of scored.filter((x) => x.fit.route === 'filtered_out')) {
    const job = store.upsertJob(s.posting);
    store.setJobFit(job.id, { score: s.fit.score, route: s.fit.route, detail: s.fit });
    result.filteredOut++;
  }

  const target = prefs.dailyTarget ?? 10;
  const already = Number(store.getKv(dayKey(now)) ?? 0);
  const quota = Math.max(0, target - already);
  const eligible = scored.filter((x) => x.fit.route !== 'filtered_out').sort((a, b) => b.fit.score + b.boost - (a.fit.score + a.boost));
  result.admitted = eligible.slice(0, quota);
  // Top matches are worth more than the daily number: let a few extra through.
  const hotKey = `${dayKey(now)}_hot`;
  const hotUsed = Number(store.getKv(hotKey) ?? 0);
  const hot = eligible.slice(quota).filter((x) => x.fit.score >= (prefs.hotScore ?? 85)).slice(0, Math.max(0, (prefs.hotExtra ?? 3) - hotUsed));
  result.admitted.push(...hot);
  if (hot.length) store.setKv(hotKey, String(hotUsed + hot.length));
  result.deferred = eligible.length - result.admitted.length;
  result.quotaLeft = Math.max(0, quota - result.admitted.length);
  store.setKv(dayKey(now), String(already + result.admitted.length - hot.length));
  return result;
}
