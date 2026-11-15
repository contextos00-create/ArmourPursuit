'use strict';

/**
 * Strategy reports built from what the pipeline has already collected:
 *   skillsGap     skills postings keep asking for that the resume never mentions
 *   salaryIntel   posted pay ranges by level and work mode
 *   whatWorks     callback rates by source, fit band, title family and work mode
 *   learnedBoost  a small ranking nudge toward groups that get callbacks
 * Everything is counted from stored postings and statuses. Nothing is estimated
 * from outside data.
 */

import { extractRequirements } from './requirements';
import { detectWorkMode, levelFromTitle, parseSalary } from './scoring';
import type { JobHuntStore } from './store';
import { matchesTerm } from './synonyms';
import type { ApplicationStatus, JobPosting, MasterResume } from './types';

export function resumeText(master: MasterResume): string {
  return [
    master.basics.label, master.basics.summary,
    ...(master.work ?? []).flatMap((w) => [w.position, w.summary, ...(w.highlights ?? [])]),
    ...(master.projects ?? []).flatMap((p) => [p.name, p.description, ...(p.highlights ?? []), ...(p.keywords ?? [])]),
    ...(master.skills ?? []).flatMap((s) => [s.name, ...(s.keywords ?? [])]),
    ...(master.certificates ?? []).map((c) => c.name),
  ].filter(Boolean).join('\n');
}

function considered(store: JobHuntStore): JobPosting[] {
  return store.allJobs().filter((j) => j.fitRoute !== 'filtered_out');
}

export interface GapRow {
  term: string;
  postings: number;
  share: number;
  asMust: number;
}

/** Skills that matched postings ask for and the resume never mentions, most common first. */
export function skillsGap(store: JobHuntStore, master: MasterResume, options: { top?: number; minPostings?: number } = {}): { total: number; rows: GapRow[] } {
  const jobs = considered(store);
  const resume = resumeText(master);
  const counts = new Map<string, { postings: number; asMust: number }>();
  for (const job of jobs) {
    const seen = new Map<string, boolean>();
    for (const r of extractRequirements(job.descriptionText, master)) {
      for (const k of r.keywords) seen.set(k, (seen.get(k) ?? false) || r.kind === 'must');
    }
    for (const [term, must] of seen) {
      if (matchesTerm(resume, term)) continue;
      const c = counts.get(term) ?? { postings: 0, asMust: 0 };
      c.postings++;
      if (must) c.asMust++;
      counts.set(term, c);
    }
  }
  const rows = [...counts]
    .filter(([, c]) => c.postings >= (options.minPostings ?? 2))
    .map(([term, c]) => ({ term, postings: c.postings, asMust: c.asMust, share: jobs.length ? Math.round((c.postings / jobs.length) * 100) : 0 }))
    .sort((a, b) => b.postings - a.postings || b.asMust - a.asMust || a.term.localeCompare(b.term))
    .slice(0, options.top ?? 15);
  return { total: jobs.length, rows };
}

export interface SalaryRow {
  group: string;
  n: number;
  medianMin: number;
  medianMax: number;
  low: number;
  high: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Posted pay ranges, grouped by level and by work mode. Only postings that state a range count. */
export function salaryIntel(store: JobHuntStore): { withPay: number; total: number; rows: SalaryRow[]; top: { company: string; title: string; max: number }[] } {
  const jobs = store.allJobs();
  const priced = jobs.map((j) => ({ j, pay: parseSalary(j.descriptionText) })).filter((x) => x.pay) as { j: JobPosting; pay: { min: number; max: number } }[];
  const groups = new Map<string, { min: number; max: number }[]>();
  const add = (g: string, pay: { min: number; max: number }) => groups.set(g, [...(groups.get(g) ?? []), pay]);
  for (const { j, pay } of priced) {
    add('All', pay);
    add(`Level: ${levelFromTitle(j.title) ?? 'mid'}`, pay);
    add(`Mode: ${detectWorkMode(j.descriptionText, j.location) ?? 'unstated'}`, pay);
  }
  const rows = [...groups].map(([group, ps]) => ({
    group, n: ps.length, medianMin: median(ps.map((p) => p.min)), medianMax: median(ps.map((p) => p.max)),
    low: Math.min(...ps.map((p) => p.min)), high: Math.max(...ps.map((p) => p.max)),
  })).sort((a, b) => (a.group === 'All' ? -1 : b.group === 'All' ? 1 : a.group.localeCompare(b.group)));
  const top = priced.sort((a, b) => b.pay.max - a.pay.max).slice(0, 5).map(({ j, pay }) => ({ company: j.company, title: j.title, max: pay.max }));
  return { withPay: priced.length, total: jobs.length, rows, top };
}

const POSITIVE: ApplicationStatus[] = ['assessment', 'screening', 'interviewing', 'offer', 'accepted'];
const SENT: ApplicationStatus[] = ['applied', 'acknowledged', 'bounced', 'rejected', 'ghosted', ...POSITIVE];

export function titleFamily(title: string): string {
  const t = title.toLowerCase();
  if (/\bsdet\b|engineer in test|software development engineer.*test/.test(t)) return 'SDET';
  if (/automation/.test(t)) return 'QA automation';
  if (/analyst/.test(t)) return 'QA analyst';
  if (/\b(qa|quality)\b/.test(t)) return 'QA engineer';
  if (/test/.test(t)) return 'Test engineer';
  return 'Other';
}

function fitBand(score: number | null | undefined): string {
  if (score == null) return 'unscored';
  return score >= 80 ? '80+' : score >= 65 ? '65-79' : '<65';
}

export interface WorkRow {
  dimension: string;
  group: string;
  sent: number;
  callbacks: number;
  rate: number;
}

/** Callback rate (assessment or further) by source, fit band, title family and work mode. */
export function whatWorks(store: JobHuntStore): { sent: number; callbacks: number; rate: number; rows: WorkRow[] } {
  const apps = store.listApplications().map((a) => ({ a, reached: new Set(store.history(a.id).map((h) => h.toStatus)) }))
    .filter(({ reached }) => SENT.some((s) => reached.has(s)));
  const positive = (r: Set<ApplicationStatus>) => POSITIVE.some((s) => r.has(s));
  const dims: [string, (j: JobPosting) => string][] = [
    ['Source', (j) => j.source],
    ['Fit', (j) => fitBand(j.fitScore)],
    ['Title', (j) => titleFamily(j.title)],
    ['Mode', (j) => detectWorkMode(j.descriptionText, j.location) ?? 'unstated'],
  ];
  const rows: WorkRow[] = [];
  for (const [dimension, key] of dims) {
    const groups = new Map<string, { sent: number; callbacks: number }>();
    for (const { a, reached } of apps) {
      const g = groups.get(key(a.job)) ?? { sent: 0, callbacks: 0 };
      g.sent++;
      if (positive(reached)) g.callbacks++;
      groups.set(key(a.job), g);
    }
    for (const [group, g] of groups) rows.push({ dimension, group, ...g, rate: Math.round((g.callbacks / g.sent) * 100) });
  }
  const callbacks = apps.filter(({ reached }) => positive(reached)).length;
  return { sent: apps.length, callbacks, rate: apps.length ? Math.round((callbacks / apps.length) * 100) : 0, rows };
}

/**
 * Ranking nudge from real outcomes. Off until there are minSent applications;
 * a group needs at least minGroup sends and a gap of 10+ points from the
 * overall rate to count. Capped at +/-8.
 */
export function learnedBoost(store: JobHuntStore, job: JobPosting, options: { minSent?: number; minGroup?: number } = {}): { delta: number; reasons: string[] } {
  const w = whatWorks(store);
  if (w.sent < (options.minSent ?? 30)) return { delta: 0, reasons: [] };
  const keys: Record<string, string> = {
    Source: job.source, Fit: fitBand(job.fitScore), Title: titleFamily(job.title),
    Mode: detectWorkMode(job.descriptionText, job.location) ?? 'unstated',
  };
  let delta = 0;
  const reasons: string[] = [];
  for (const r of w.rows) {
    if (keys[r.dimension] !== r.group || r.sent < (options.minGroup ?? 8) || r.dimension === 'Fit') continue;
    const diff = r.rate - w.rate;
    if (Math.abs(diff) < 10) continue;
    const step = Math.max(-4, Math.min(4, Math.round(diff / 5)));
    delta += step;
    reasons.push(`${r.dimension.toLowerCase()} ${r.group}: ${r.rate}% callbacks vs ${w.rate}% overall`);
  }
  return { delta: Math.max(-8, Math.min(8, delta)), reasons };
}
