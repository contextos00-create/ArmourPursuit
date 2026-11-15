'use strict';

/**
 * Structured fit score (0-100) and routing, per the build spec section 3:
 *   Skill overlap 40, Role and seniority 30, Domain and impact 20, Logistics and comp 10.
 * Hard filters reject a posting outright. Routing:
 *   >= 80 auto-tailor, 65-79 (or a dream company) needs approval, < 65 filtered out.
 *
 * Deterministic so it is cheap, explainable, and testable. Anything the posting
 * or preferences do not state scores half credit and says "unknown".
 */

import { extractRequirements } from './requirements';
import { masterText } from './tailor';
import { matchesTerm } from './synonyms';
import { containsTerm, normalizeTerm } from './text';
import type { JobPosting, MasterResume } from './types';

export interface SearchPreferences {
  targetTitles?: string[];
  /** Candidate's own level. Defaults to the level in the most recent work title. */
  seniority?: Level;
  track?: 'ic' | 'manager';
  domains?: string[];
  workModes?: WorkMode[];
  /** City or region names where onsite/hybrid is acceptable. */
  locations?: string[];
  salaryFloor?: number;
  needsSponsorship?: boolean;
  blockedCompanies?: string[];
  dreamCompanies?: string[];
  /** Override computed years of experience. */
  yearsExperience?: number;
  /** "US" filters out postings located only outside the United States. */
  country?: 'US';
  /** Routing thresholds. Defaults 80 and 65 per the build spec. */
  autoTailorAt?: number;
  approvalAt?: number;
}

export type Level = 'intern' | 'junior' | 'mid' | 'senior' | 'staff' | 'principal' | 'manager' | 'director' | 'executive';
export type WorkMode = 'remote' | 'hybrid' | 'onsite';
export type Route = 'auto_tailor' | 'needs_approval' | 'filtered_out';

export interface FitScore {
  score: number;
  breakdown: { skills: number; role: number; domain: number; logistics: number };
  route: Route;
  hardFilter: string | null;
  rationale: string[];
}

const LEVEL_RANK: Record<Level, number> = { intern: 0, junior: 1, mid: 2, senior: 3, staff: 4, principal: 5, manager: 4, director: 6, executive: 7 };

export function levelFromTitle(title: string): Level | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return 'intern';
  if (/\b(chief|vp|vice president|head of)\b/.test(t)) return 'executive';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\bprincipal\b|\bdistinguished\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(manager|mgr)\b/.test(t) && !/\b(product|project|program|account) manager\b/.test(t)) return 'manager';
  if (/\b(senior|sr\.?|lead)\b|\biii\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry|associate|new grad)\b|\bi\b/.test(t)) return 'junior';
  if (/\bii\b/.test(t)) return 'mid';
  return null;
}

const NON_US = /\b(canada|india|bengaluru|bangalore|hyderabad|pune|uk|united kingdom|london|ireland|dublin|europe|emea|apac|latam|mexico|brazil|germany|berlin|france|paris|spain|netherlands|amsterdam|poland|singapore|taiwan|taipei|japan|tokyo|australia|sydney|philippines|israel|portugal|argentina|colombia|korea|china)\b/i;
const US = /\b(united states|usa|u\.s\.|us|remote us|us remote|[A-Z]{2})\b|,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;

/** False only when the location clearly names somewhere outside the US and no US place. */
export function isUsLocation(location: string | null): boolean {
  if (!location) return true;
  const parts = location.split(/[;|]/);
  return parts.some((p) => !NON_US.test(p) || /\b(united states|usa)\b/i.test(p)) || US.test(location) && !NON_US.test(location);
}

/**
 * Work mode from the location field first (most reliable), then explicit
 * phrases in the description. A bare "remote" in prose ("remote sensing",
 * "remote teams") is not enough.
 */
export function detectWorkMode(text: string, location?: string | null): WorkMode | null {
  const loc = (location ?? '').toLowerCase();
  if (/\bhybrid\b/.test(loc)) return 'hybrid';
  if (/\bremote\b/.test(loc)) return 'remote';
  const t = text.toLowerCase();
  if (/\bhybrid (role|position|schedule|work)|\bthis (role|position) is hybrid\b|\b\d days? (a|per) week in (the )?office\b/.test(t)) return 'hybrid';
  if (/\b(fully remote|remote[- ]first|100% remote|remote (role|position|opportunity|job)|work from (home|anywhere)|this (role|position) is remote|remote,? (us|usa|united states))\b/.test(t)) return 'remote';
  if (/\b(on[- ]?site|in[- ]office|in office)\b/.test(t)) return 'onsite';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  return null;
}

/** Largest dollar range or figure in the text, as annual USD. */
export function parseSalary(text: string): { min: number; max: number } | null {
  const toNum = (s: string, k?: string) => {
    const n = Number(s.replace(/,/g, ''));
    return k && /k/i.test(k) ? n * 1000 : n;
  };
  const range = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\s*(?:-|to|–|—)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?/i);
  if (range) {
    const min = toNum(range[1], range[2] || range[4]);
    const max = toNum(range[3], range[4]);
    if (min >= 10_000 && max >= min) return { min, max };
  }
  return null;
}

export function requiredYears(text: string): number | null {
  const all = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 30);
  return all.length ? Math.max(...all) : null;
}

function monthIndex(date?: string): number | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})(?:-(\d{1,2}))?/);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
}

/** Total years across work entries, merging overlaps. */
export function yearsOfExperience(master: MasterResume, now = new Date()): number {
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const spans = (master.work ?? [])
    .map((w) => [monthIndex(w.startDate), w.endDate ? monthIndex(w.endDate) : nowIdx] as const)
    .filter((s): s is readonly [number, number] => s[0] != null && s[1] != null && s[1] >= s[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of spans) {
    if (s > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return Math.round((total / 12) * 10) / 10;
}

const TITLE_SYNONYMS: [RegExp, string][] = [
  [/\bquality assurance\b/g, 'qa'], [/\bquality\b/g, 'qa'], [/\bsdet\b|\bsoftware development engineer in test\b/g, 'qa automation engineer'],
  [/\btest(er|ing)?\b/g, 'qa'], [/\bdeveloper\b/g, 'engineer'], [/\banalyst\b/g, 'engineer'], [/\bswe\b/g, 'software engineer'],
];

function canonicalTitle(title: string): string {
  let t = normalizeTerm(title);
  for (const [re, to] of TITLE_SYNONYMS) t = t.replace(re, to);
  return t;
}

function titleSimilarity(a: string, b: string): number {
  a = canonicalTitle(a);
  b = canonicalTitle(b);
  const ta = new Set(normalizeTerm(a).split(' ').filter((w) => w.length > 1 && !['senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'i', 'ii', 'iii'].includes(w)));
  const tb = new Set(normalizeTerm(b).split(' ').filter((w) => ta.has(w)));
  return ta.size ? tb.size / ta.size : 0;
}

export function scoreFit(master: MasterResume, job: JobPosting, prefs: SearchPreferences = {}, now = new Date()): FitScore {
  const rationale: string[] = [];
  const text = `${job.title}\n${job.location ?? ''}\n${job.descriptionText}`;
  const company = job.company.toLowerCase();
  const isDream = (prefs.dreamCompanies ?? []).some((c) => c.toLowerCase() === company);

  // ── Hard filters ──
  let hardFilter: string | null = null;
  const years = prefs.yearsExperience ?? yearsOfExperience(master, now);
  const reqYears = requiredYears(job.descriptionText);
  const mode = detectWorkMode(job.descriptionText, job.location);
  const salary = parseSalary(job.descriptionText);
  if ((prefs.blockedCompanies ?? []).some((c) => c.toLowerCase() === company)) hardFilter = 'company is on your blocked list';
  else if (prefs.country === 'US' && !isUsLocation(job.location)) hardFilter = `located outside the US (${job.location})`;
  else if (prefs.needsSponsorship && /\b(no|not|unable to|cannot|won't|will not)\b[^.\n]{0,40}\bsponsor/i.test(job.descriptionText)) hardFilter = 'posting does not offer visa sponsorship';
  else if (reqYears != null && reqYears > years + 2) hardFilter = `asks for ${reqYears}+ years, you have about ${years}`;
  else if (prefs.salaryFloor && salary && salary.max < prefs.salaryFloor) hardFilter = `pay tops out at $${salary.max.toLocaleString()}, below your $${prefs.salaryFloor.toLocaleString()} floor`;
  else if (mode && mode !== 'remote' && prefs.workModes?.length && !prefs.workModes.includes(mode)) hardFilter = `${mode} role, you want ${prefs.workModes.join('/')}`;
  else if (mode !== 'remote' && prefs.locations?.length && job.location && !/\bremote\b/i.test(job.location) && !prefs.locations.some((l) => containsTerm(job.location!, l))) {
    hardFilter = `${mode ?? 'based'} in ${job.location}, outside your locations`;
  }

  // ── Skills (40) ──
  const requirements = extractRequirements(job.descriptionText, master);
  const corpus = masterText(master);
  const weights = new Map<string, number>();
  for (const r of requirements) for (const k of r.keywords) weights.set(k, Math.max(weights.get(k) ?? 0, r.kind === 'must' ? 2 : 1));
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const hit = [...weights].filter(([k]) => matchesTerm(corpus, k));
  // No recognizable skills usually means a non-software role; give no credit rather than half.
  const skills = total ? Math.round((hit.reduce((a, [, w]) => a + w, 0) / total) * 40) : 0;
  rationale.push(total ? `skills ${skills}/40: ${hit.length} of ${weights.size} requested skills on your resume` : 'skills 0/40: no recognizable skills in posting');

  // ── Role and seniority (30) ──
  const titleTargets = prefs.targetTitles?.length
    ? prefs.targetTitles
    : [master.basics.label, ...(master.work ?? []).map((w) => w.position)].filter((t): t is string => !!t);
  const bestTitle = titleTargets.reduce((m, t) => Math.max(m, titleSimilarity(t, job.title)), 0);
  const titlePts = titleTargets.length ? Math.round(bestTitle * 15) : 8;
  const myLevel = prefs.seniority ?? levelFromTitle(master.work?.[0]?.position ?? '') ?? 'mid';
  const jobLevel = levelFromTitle(job.title) ?? 'mid';
  const gap = Math.abs(LEVEL_RANK[myLevel] - LEVEL_RANK[jobLevel]);
  const levelPts = gap === 0 ? 10 : gap === 1 ? 6 : 0;
  const myTrack = prefs.track ?? (['manager', 'director', 'executive'].includes(myLevel) ? 'manager' : 'ic');
  const jobTrack = ['manager', 'director', 'executive'].includes(jobLevel) ? 'manager' : 'ic';
  const trackPts = myTrack === jobTrack ? 5 : 0;
  const role = titlePts + levelPts + trackPts;
  rationale.push(`role ${role}/30: title match ${Math.round(bestTitle * 100)}%, level ${jobLevel} vs your ${myLevel}, ${jobTrack === myTrack ? 'same' : 'different'} track`);

  // ── Domain and impact (20) ──
  let domain = 10;
  if (prefs.domains?.length) {
    const matched = prefs.domains.filter((d) => containsTerm(text, d));
    domain = Math.round(Math.min(1, matched.length / Math.min(2, prefs.domains.length)) * 20);
    rationale.push(`domain ${domain}/20: ${matched.length ? `mentions ${matched.join(', ')}` : 'none of your domains mentioned'}`);
  } else rationale.push('domain 10/20: unknown (set domains in preferences)');

  // ── Logistics and comp (10) ──
  let modePts = 2.5;
  if (mode && prefs.workModes?.length) modePts = prefs.workModes.includes(mode) ? 5 : 0;
  let payPts = 2.5;
  if (salary && prefs.salaryFloor) payPts = salary.max >= prefs.salaryFloor ? (salary.min >= prefs.salaryFloor ? 5 : 3) : 0;
  const logistics = Math.round(modePts + payPts);
  rationale.push(`logistics ${logistics}/10: ${mode ?? 'work mode unknown'}, ${salary ? `$${salary.min.toLocaleString()} to $${salary.max.toLocaleString()}` : 'pay not listed'}`);

  const score = Math.max(0, Math.min(100, skills + role + domain + logistics));
  const autoAt = prefs.autoTailorAt ?? 80;
  const okAt = prefs.approvalAt ?? 65;
  let route: Route = score >= autoAt ? 'auto_tailor' : score >= okAt ? 'needs_approval' : 'filtered_out';
  if (isDream && route !== 'auto_tailor') route = 'needs_approval';
  if (hardFilter) {
    route = 'filtered_out';
    rationale.unshift(`filtered: ${hardFilter}`);
  }
  return { score, breakdown: { skills, role, domain, logistics }, route, hardFilter, rationale };
}
