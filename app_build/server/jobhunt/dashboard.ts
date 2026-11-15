'use strict';

/**
 * Static tracking dashboard: one self-contained HTML file (no network, no
 * build step) written next to the documents folder and refreshed by the
 * scheduler. Open data/jobhunt/dashboard.html in a browser.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JobHuntStore } from './store';
import { documentDirName, escapeHtml } from './text';
import type { ApplicationStatus } from './types';

/** Pipeline order used for "how far it got". */
export const STAGES: ApplicationStatus[] = ['saved', 'tailored', 'applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer', 'accepted'];
const TERMINAL: Record<string, string> = { rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'No response', accepted: 'Accepted', bounced: 'Email bounced' };
const LABEL: Record<string, string> = {
  saved: 'Saved', tailored: 'Tailored', applied: 'Applied', acknowledged: 'Received', assessment: 'Assessment', screening: 'Screening',
  interviewing: 'Interviewing', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted', bounced: 'Bounced',
};

export function furthestStage(statuses: ApplicationStatus[]): ApplicationStatus {
  let best = 0;
  for (const s of statuses) best = Math.max(best, STAGES.indexOf(s));
  return STAGES[Math.max(0, best)];
}

export function linkedinSearch(keywords: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}

export interface DashboardRow {
  id: string;
  code: string;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  fit: number | null;
  route: string | null;
  status: ApplicationStatus;
  furthest: ApplicationStatus;
  /** Every status this application has been in. */
  reached: ApplicationStatus[];
  result: string;
  appliedAt: number | null;
  updatedAt: number;
  docs: { label: string; href: string }[];
  contacts: { name: string | null; title: string | null; email: string | null; linkedin: string }[];
  hiringSearch: string;
  timeline: { at: number; to: string; reason: string | null; source: string }[];
  gaps: string[];
}

export function dashboardRows(store: JobHuntStore, docsDir: string | null, docsHref = 'documents'): DashboardRow[] {
  return store.listApplications().map((a) => {
    const history = store.history(a.id);
    const furthest = furthestStage(history.map((h) => h.toStatus));
    const dir = documentDirName(a.job, a.id);
    const docs: DashboardRow['docs'] = [];
    for (const [file, label] of [['resume.pdf', 'Resume PDF'], ['resume.html', 'Resume'], ['cover-letter.html', 'Cover letter'], ['report.json', 'Fit report']]) {
      if (!docsDir || existsSync(join(docsDir, dir, file))) {
        if (docsDir || store.latestDocument(a.id, 'resume')) docs.push({ label, href: docsHref.endsWith(':') ? `${docsHref}${dir}/${file}` : `${docsHref}/${dir}/${file}` });
      }
    }
    // Files that exist only for some applications.
    const extras: [string, string][] = [['prep.html', 'Interview prep'], ['referral-ask.txt', 'Referral ask'], ['outreach-note.txt', 'Outreach note'],
      ['follow-up-note.txt', 'Follow-up note'], ['thank-you-note.txt', 'Thank-you note'], ['apply-screenshot.png', 'Form screenshot']];
    for (const [file, label] of extras) if (docsDir && existsSync(join(docsDir, dir, file))) docs.push({ label, href: docsHref.endsWith(':') ? `${docsHref}${dir}/${file}` : `${docsHref}/${dir}/${file}` });
    const report: any = store.latestDocument(a.id, 'resume')?.report ?? null;
    return {
      id: a.id,
      code: a.id.slice(0, 4),
      company: a.job.company,
      title: a.job.title,
      location: a.job.location,
      url: a.job.url,
      fit: a.job.fitScore ?? null,
      route: a.job.fitRoute ?? null,
      status: a.status,
      furthest,
      reached: [...new Set(history.map((h) => h.toStatus))],
      result: TERMINAL[a.status] ?? (a.status === 'offer' ? 'Offer' : 'In progress'),
      appliedAt: a.appliedAt,
      updatedAt: a.updatedAt,
      docs,
      contacts: store.contacts(a.id).map((c) => ({
        name: c.name, title: c.title, email: c.email,
        linkedin: c.linkedinUrl ?? linkedinSearch(`${c.name ?? ''} ${a.job.company}`.trim()),
      })),
      hiringSearch: linkedinSearch(`${a.job.company} QA manager`),
      timeline: history.map((h) => ({ at: h.createdAt, to: h.toStatus, reason: h.reason, source: h.source })),
      gaps: report?.gaps ?? [],
    };
  });
}

function fmtDate(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface DashboardInsights {
  gap: { total: number; rows: { term: string; postings: number; share: number; asMust: number }[] };
  salary: { withPay: number; total: number; rows: { group: string; n: number; medianMin: number; medianMax: number }[] };
  works: { sent: number; callbacks: number; rate: number; rows: { dimension: string; group: string; sent: number; callbacks: number; rate: number }[] };
}

/** One horizontal bar row: label, track with fill, value. */
function barRow(label: string, share: number, value: string, tip: string): string {
  const e = escapeHtml;
  const w = Math.max(0, Math.min(100, share));
  return `<div class="bar-row" data-tip="${e(tip)}"><span class="bar-label">${e(label)}</span><span class="bar"><span class="bar-fill" style="width:${w}%"></span></span><span class="bar-n">${e(value)}</span></div>`;
}

function insightsHtml(i: DashboardInsights): string {
  const e = escapeHtml;
  const money = (n: number) => `$${Math.round(n / 1000)}k`;
  const gapRows = i.gap.rows.slice(0, 8);
  const gap = gapRows.length
    ? `<p class="muted note">Share of the ${i.gap.total} matched postings that ask for each skill.</p>${gapRows.map((r) => barRow(r.term, r.share, `${r.share}%`, `${r.term}: in ${r.postings} postings, a must-have in ${r.asMust}`)).join('')}`
    : '<p class="muted note">Not enough postings yet.</p>';
  const payMax = Math.max(1, ...i.salary.rows.map((r) => r.medianMax));
  const pay = i.salary.rows.length
    ? `<p class="muted note">Median posted range. ${i.salary.withPay} of ${i.salary.total} postings list pay.</p>${i.salary.rows.map((r) => {
      const left = (r.medianMin / payMax) * 100;
      const width = Math.max(1.5, ((r.medianMax - r.medianMin) / payMax) * 100);
      return `<div class="bar-row pay" data-tip="${e(`${r.group}: ${money(r.medianMin)} to ${money(r.medianMax)} across ${r.n} postings`)}"><span class="bar-label">${e(r.group)}</span><span class="bar"><span class="bar-fill range" style="margin-left:${left}%;width:${width}%"></span></span><span class="bar-n">${money(r.medianMin)} to ${money(r.medianMax)}</span></div>`;
    }).join('')}`
    : '<p class="muted note">No postings with a pay range yet.</p>';
  const works = i.works.sent >= 5
    ? `<p class="muted note">${i.works.callbacks} callbacks from ${i.works.sent} sent (${i.works.rate}%). A group needs about 8 sends before its rate means much.</p>${i.works.rows.map((r) => barRow(`${r.dimension}: ${r.group}`, r.rate, `${r.rate}%`, `${r.dimension} ${r.group}: ${r.callbacks} callbacks from ${r.sent} sent`)).join('')}`
    : `<p class="muted note">${i.works.sent} sent so far. This fills in after 5 or more.</p>`;
  return `<section class="grid3 insights">
<div class="panel"><h4>Skills gap</h4><p class="lede">Asked for, not on the resume</p>${gap}</div>
<div class="panel"><h4>Pay in collected postings</h4><p class="lede">What the market is offering</p>${pay}</div>
<div class="panel"><h4>What's getting callbacks</h4><p class="lede">Callback rate by group</p>${works}</div>
</section>`;
}

const DAY = 86_400_000;
const BUCKETS: { key: string; label: string; statuses: ApplicationStatus[] }[] = [
  { key: 'queued', label: 'Queued', statuses: ['saved', 'tailored'] },
  { key: 'waiting', label: 'Waiting to hear', statuses: ['applied', 'acknowledged'] },
  { key: 'talking', label: 'In conversation', statuses: ['assessment', 'screening', 'interviewing', 'offer', 'accepted'] },
  { key: 'closed', label: 'Closed', statuses: ['rejected', 'ghosted', 'withdrawn', 'bounced'] },
];
const FIT_BANDS: [string, number, number][] = [['Under 50', 0, 49], ['50 to 64', 50, 64], ['65 to 79', 65, 79], ['80 to 89', 80, 89], ['90 and up', 90, 100]];

/** Applications sent in each of the last `weeks` weeks, oldest first. */
export function weeklySent(rows: DashboardRow[], now: number, weeks = 8): { start: number; n: number }[] {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  // Weeks start on Monday.
  const thisWeek = end.getTime() - ((end.getDay() + 6) % 7) * DAY;
  const out = Array.from({ length: weeks }, (_, i) => ({ start: thisWeek - (weeks - 1 - i) * 7 * DAY, n: 0 }));
  for (const r of rows) {
    const at = r.timeline.find((t) => t.to === 'applied')?.at ?? r.appliedAt;
    if (!at) continue;
    const idx = Math.floor((at - out[0].start) / (7 * DAY));
    if (idx >= 0 && idx < weeks) out[idx].n++;
  }
  return out;
}

export interface DashboardMetrics {
  tracked: number;
  applied: number;
  active: number;
  responded: number;
  responseRate: number;
  interviews: number;
  offers: number;
  foundToday: number;
  sentThisWeek: number;
  /** Applications sent per week, oldest first, last 8 weeks. */
  weeks: number[];
  buckets: { key: string; label: string; n: number }[];
}

/** The headline numbers, shared by the dashboard page and the command center. */
export function dashboardMetrics(rows: DashboardRow[], now = Date.now()): DashboardMetrics {
  const at = (s: ApplicationStatus) => STAGES.indexOf(s);
  const applied = rows.filter((r) => at(r.furthest) >= at('applied'));
  const responded = applied.filter((r) => at(r.furthest) >= at('acknowledged') || r.status === 'rejected');
  const weeks = weeklySent(rows, now).map((w) => w.n);
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  return {
    tracked: rows.length,
    applied: applied.length,
    active: rows.filter((r) => ['applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer'].includes(r.status)).length,
    responded: responded.length,
    responseRate: applied.length ? Math.round((responded.length / applied.length) * 100) : 0,
    interviews: rows.filter((r) => at(r.furthest) >= at('screening')).length,
    offers: rows.filter((r) => ['offer', 'accepted'].includes(r.furthest)).length,
    foundToday: rows.filter((r) => (r.timeline[0]?.at ?? r.updatedAt) >= startOfDay).length,
    sentThisWeek: weeks[weeks.length - 1],
    weeks,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label, n: rows.filter((r) => b.statuses.includes(r.status)).length })),
  };
}

/** Everything the command center's dashboard draws, as data. Same numbers as renderDashboard. */
export interface DashboardData {
  now: number;
  target: number | null;
  metrics: DashboardMetrics;
  /** Last 8 weeks, oldest first: postings found, applications sent, first replies received. */
  weeks: { start: number; found: number; applied: number; replies: number }[];
  /** Last 26 weeks of days, oldest first: status changes logged that day. */
  days: { day: number; n: number }[];
  funnel: { stage: ApplicationStatus; label: string; n: number }[];
  bands: { label: string; n: number }[];
  insights: DashboardInsights | null;
  rows: (DashboardRow & { statusLabel: string; furthestLabel: string; stageIndex: number })[];
}

const REPLY_STATUSES = ['acknowledged', 'assessment', 'screening', 'interviewing', 'offer', 'accepted', 'rejected'];

export function dashboardData(rows: DashboardRow[], options: { now?: number; insights?: DashboardInsights; dailyTarget?: number } = {}): DashboardData {
  const now = options.now ?? Date.now();
  const sent = weeklySent(rows, now);
  const weeks = sent.map((w) => ({ start: w.start, found: 0, applied: w.n, replies: 0 }));
  const weekOf = (at: number) => Math.floor((at - weeks[0].start) / (7 * DAY));
  const today = new Date(now).setHours(0, 0, 0, 0);
  const span = 182;
  const firstDay = today - (span - 1) * DAY;
  const days = Array.from({ length: span }, (_, i) => ({ day: firstDay + i * DAY, n: 0 }));
  for (const r of rows) {
    const found = r.timeline[0]?.at ?? r.updatedAt;
    const fi = weekOf(found);
    if (fi >= 0 && fi < weeks.length) weeks[fi].found++;
    const reply = r.timeline.find((t) => REPLY_STATUSES.includes(t.to))?.at;
    if (reply) {
      const ri = weekOf(reply);
      if (ri >= 0 && ri < weeks.length) weeks[ri].replies++;
    }
    for (const t of r.timeline) {
      const di = Math.floor((new Date(t.at).setHours(0, 0, 0, 0) - firstDay) / DAY + 0.5);
      if (di >= 0 && di < span) days[di].n++;
    }
  }
  const funnel = STAGES.filter((s) => s !== 'saved').map((s) => ({
    stage: s,
    label: LABEL[s] ?? s,
    n: rows.filter((r) => (s === 'assessment' ? r.reached.includes(s) : STAGES.indexOf(r.furthest) >= STAGES.indexOf(s))).length,
  }));
  const scored = rows.filter((r) => r.fit != null);
  return {
    now,
    target: options.dailyTarget && options.dailyTarget > 0 ? options.dailyTarget : null,
    metrics: dashboardMetrics(rows, now),
    weeks,
    days,
    funnel,
    bands: FIT_BANDS.map(([label, lo, hi]) => ({ label, n: scored.filter((r) => (r.fit as number) >= lo && (r.fit as number) <= hi).length })),
    insights: options.insights ?? null,
    rows: rows.map((r) => ({ ...r, statusLabel: LABEL[r.status] ?? r.status, furthestLabel: LABEL[r.furthest] ?? r.furthest, stageIndex: STAGES.indexOf(r.furthest) })),
  };
}

function ring(share: number): string {
  const r = 20;
  const c = 2 * Math.PI * r;
  const on = Math.max(0, Math.min(1, share)) * c;
  return `<svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="${r}" class="ring-bg"/><circle cx="24" cy="24" r="${r}" class="ring-on" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 24 24)"/></svg>`;
}

function spark(values: number[]): string {
  const max = Math.max(1, ...values);
  const w = 96;
  const h = 28;
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polygon class="spark-area" points="0,${h} ${pts.join(' ')} ${w},${h}"/><polyline class="spark-line" points="${pts.join(' ')}"/></svg>`;
}

export function renderDashboard(rows: DashboardRow[], options: { title?: string; now?: number; insights?: DashboardInsights; dailyTarget?: number } = {}): string {
  const e = escapeHtml;
  const now = options.now ?? Date.now();
  const m = dashboardMetrics(rows, now);
  const share = (n: number, d: number) => (d ? n / d : 0);
  const pct = (n: number, d: number) => `${Math.round(share(n, d) * 100)}%`;
  // Assessment is optional (many processes skip it), so count it only when it happened.
  const funnel = STAGES.filter((s) => s !== 'saved').map((s) => ({
    s,
    n: rows.filter((r) => (s === 'assessment' ? r.reached.includes(s) : STAGES.indexOf(r.furthest) >= STAGES.indexOf(s))).length,
  }));
  const maxN = Math.max(1, ...funnel.map((f) => f.n));
  const statuses = [...new Set(rows.map((r) => r.status))];
  const weeks = weeklySent(rows, now);
  const target = options.dailyTarget && options.dailyTarget > 0 ? options.dailyTarget : null;

  const tile = (k: string, v: string | number, sub: string, extra = '', cls = '') =>
    `<div class="tile ${cls}"><div class="tile-top"><div><div class="tile-k">${e(k)}</div><div class="tile-v">${e(String(v))}</div></div>${extra}</div><div class="tile-sub">${e(sub)}</div></div>`;
  const tiles = [
    target
      ? tile('Found today', `${m.foundToday} of ${target}`, m.foundToday >= target ? 'Daily number reached' : `${target - m.foundToday} to go today`, ring(share(m.foundToday, target)), 'hero')
      : tile('Tracked', rows.length, 'Postings in the pipeline', '', 'hero'),
    tile('Applied', m.applied, `${m.sentThisWeek} sent this week`, spark(weeks.map((w) => w.n))),
    tile('Response rate', pct(m.responded, m.applied), `${m.responded} of ${m.applied} heard back`, ring(share(m.responded, m.applied))),
    tile('Active', m.active, 'Sent and still open'),
    tile('Reached interview', m.interviews, `${pct(m.interviews, m.applied)} of applied`),
    tile('Offers', m.offers, target ? `${rows.length} postings tracked` : 'Offer or accepted'),
  ].join('');

  const weekMax = Math.max(1, ...weeks.map((w) => w.n));
  const weekLabel = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const weeksHtml = weeks.some((w) => w.n)
    ? `<div class="cols">${weeks.map((w, i) => `<div class="col${i === weeks.length - 1 ? ' now' : ''}" data-tip="${e(`Week of ${weekLabel(w.start)}: ${w.n} sent`)}"><span class="col-n">${w.n || ''}</span><span class="col-bar" style="height:${(w.n / weekMax) * 100}%"></span><span class="col-x">${e(weekLabel(w.start))}</span></div>`).join('')}</div>`
    : '<p class="muted note">Nothing sent in the last 8 weeks yet.</p>';

  const funnelHtml = funnel.map((f) => barRow(LABEL[f.s], (f.n / maxN) * 100, String(f.n), `${LABEL[f.s]}: ${f.n} of ${rows.length} tracked${f.s !== 'tailored' && m.applied ? `, ${pct(f.n, m.applied)} of applied` : ''}`)).join('');

  const buckets = m.buckets;
  const standHtml = rows.length
    ? `<div class="seg" role="img" aria-label="${e(buckets.map((b) => `${b.label} ${b.n}`).join(', '))}">${buckets.filter((b) => b.n).map((b) => `<span class="seg-part k-${b.key}" style="flex:${b.n}" data-tip="${e(`${b.label}: ${b.n} (${pct(b.n, rows.length)})`)}"></span>`).join('')}</div>
<ul class="legend">${buckets.map((b) => `<li><span class="dot k-${b.key}"></span>${e(b.label)}<strong>${b.n}</strong></li>`).join('')}</ul>`
    : '<p class="muted note">No postings tracked yet.</p>';

  const scored = rows.filter((r) => r.fit != null);
  const bands = FIT_BANDS.map(([label, lo, hi]) => ({ label, n: scored.filter((r) => (r.fit as number) >= lo && (r.fit as number) <= hi).length }));
  const bandMax = Math.max(1, ...bands.map((b) => b.n));
  const fitHtml = scored.length
    ? bands.map((b) => barRow(b.label, (b.n / bandMax) * 100, String(b.n), `Fit ${b.label.toLowerCase()}: ${b.n} of ${scored.length} scored postings`)).join('')
    : '<p class="muted note">No scored postings yet.</p>';

  const body = rows.map((r) => {
    const stageIdx = STAGES.indexOf(r.furthest);
    const steps = STAGES.slice(1, 8).map((s, i) => `<span class="step${i + 1 <= stageIdx ? ' on' : ''}" title="${e(LABEL[s])}"></span>`).join('');
    const docs = r.docs.length ? r.docs.map((d) => `<a href="${e(d.href)}" target="_blank" rel="noopener">${e(d.label)}</a>`).join(' · ') : '<span class="muted">Not tailored yet</span>';
    const contacts = r.contacts.length
      ? r.contacts.map((c) => `<div>${e(c.name ?? c.email ?? '')}${c.title ? ` <span class="muted">${e(c.title)}</span>` : ''}${c.email ? ` · <a href="mailto:${e(c.email)}">${e(c.email)}</a>` : ''} · <a href="${e(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a></div>`).join('')
      : '<span class="muted">None yet</span>';
    const timeline = r.timeline.map((t) => `<li><time>${e(fmtDate(t.at))}</time> ${e(LABEL[t.to] ?? t.to)}${t.reason ? ` <span class="muted">${e(t.reason)}</span>` : ''}</li>`).join('');
    const search = `${r.company} ${r.title} ${r.status} ${r.contacts.map((c) => c.name ?? '').join(' ')}`.toLowerCase();
    const initial = (r.company.trim()[0] ?? '?').toUpperCase();
    return `<details class="row" data-status="${e(r.status)}" data-search="${e(search)}">
<summary>
  <span class="co"><span class="avatar" aria-hidden="true">${e(initial)}</span><span class="co-text"><strong>${e(r.company)}</strong><span class="muted">${e(r.title)}${r.location ? `, ${e(r.location)}` : ''}</span></span></span>
  <span class="fit${r.fit != null && r.fit >= 80 ? ' hot' : ''}"${r.fit == null ? '' : ' title="Fit score"'}>${r.fit == null ? '' : `${r.fit}`}</span>
  <span class="pill s-${e(r.status)}">${e(LABEL[r.status] ?? r.status)}</span>
  <span class="steps" aria-label="Furthest stage: ${e(LABEL[r.furthest])}">${steps}</span>
  <span class="date">${e(fmtDate(r.appliedAt) || fmtDate(r.updatedAt))}</span>
</summary>
<div class="detail">
  <div><h4>Result</h4>${e(r.result)}, got as far as <strong>${e(LABEL[r.furthest])}</strong>. Code <code>${e(r.code)}</code>${r.url ? ` · <a href="${e(r.url)}" target="_blank" rel="noopener">Posting</a>` : ''}</div>
  <div><h4>Documents</h4>${docs}</div>
  <div><h4>Contacts</h4>${contacts}<div><a href="${e(r.hiringSearch)}" target="_blank" rel="noopener">Find the hiring manager on LinkedIn</a></div></div>
  ${r.gaps.length ? `<div><h4>Gaps left off the resume</h4>${e(r.gaps.join(', '))}</div>` : ''}
  <div class="tl"><h4>Timeline</h4><ul>${timeline}</ul></div>
</div>
</details>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(options.title ?? 'Job Tracker')}</title>
<style>
:root { color-scheme:light; --bg:#ffffff; --card:#ffffff; --ink:#0d1411; --muted:#5c6862; --line:#e3e9e5; --track:#eff4f1; --accent:#0b7a4b; --pop:#0b7a4b; --pop-ink:#ffffff; --link:#0b7a4b; --soft:#e8f5ee; --past:#bfe4d1; --ok:#0b7a4b; --warn:#8a5200; --bad:#b3261e;
  --k-queued:#d3dcd7; --k-waiting:#9fd4b9; --k-talking:#0b7a4b; --k-closed:#e9eeeb; --shadow:0 16px 32px -24px rgba(13,20,17,.3); --glow:0 22px 44px -26px rgba(11,122,75,.85); }
@media (prefers-color-scheme: dark) { :root { color-scheme:dark; --bg:#0a0f0c; --card:#101713; --ink:#eef4f0; --muted:#93a09a; --line:#202b25; --track:#18211c; --accent:#3ddc97; --pop:#3ddc97; --pop-ink:#062014; --link:#3ddc97; --soft:#13261c; --past:#1d5c41; --ok:#3ddc97; --warn:#e2ad5c; --bad:#ff8f86;
  --k-queued:#2c3a33; --k-waiting:#1f7a53; --k-talking:#3ddc97; --k-closed:#1a221e; --shadow:0 16px 32px -20px rgba(0,0,0,.8); --glow:0 22px 44px -26px rgba(61,220,151,.5); } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif; font-feature-settings:"tnum" 1; -webkit-font-smoothing:antialiased; }
main { max-width:1280px; margin:0 auto; padding:6px 2px 64px; }
h1 { font-size:32px; font-weight:750; margin:0 0 4px; letter-spacing:-.035em; line-height:1.1; } .sub { color:var(--muted); margin:0 0 24px; font-size:14px; }
.tiles { display:grid; grid-template-columns:1.55fr repeat(5,minmax(0,1fr)); gap:14px; margin-bottom:16px; }
.tile,.panel,.row { background:var(--card); border:1px solid var(--line); border-radius:16px; }
.tile { padding:18px 20px; display:flex; flex-direction:column; gap:8px; min-height:148px; min-width:0; }
.tile.hero { background:var(--pop); border-color:transparent; color:var(--pop-ink); box-shadow:var(--glow); }
.tile-top { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
.tile-k { font-size:11.5px; font-weight:650; color:var(--muted); letter-spacing:.08em; text-transform:uppercase; } .tile-v { font-size:38px; font-weight:750; letter-spacing:-.045em; line-height:1.05; margin-top:8px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.hero .tile-v { font-size:52px; }
.tile-sub { font-size:13px; color:var(--muted); margin-top:auto; } .hero .tile-k,.hero .tile-sub { color:var(--pop-ink); opacity:.85; }
.ring { width:48px; height:48px; flex-shrink:0; } .hero .ring { width:68px; height:68px; } .ring circle { fill:none; stroke-width:5; } .ring-bg { stroke:var(--track); } .ring-on { stroke:var(--accent); stroke-linecap:round; }
.hero .ring-bg { stroke:var(--pop-ink); opacity:.25; } .hero .ring-on { stroke:var(--pop-ink); }
.spark { width:72px; height:30px; flex-shrink:0; margin-top:2px; } .spark-line { fill:none; stroke:var(--accent); stroke-width:2.25; stroke-linejoin:round; stroke-linecap:round; vector-effect:non-scaling-stroke; } .spark-area { fill:var(--accent); opacity:.14; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; margin-bottom:16px; }
.grid3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; margin-bottom:28px; }
.panel { padding:22px 24px; min-width:0; }
h4 { margin:0; font-size:16px; font-weight:700; letter-spacing:-.015em; } .lede { margin:2px 0 16px; font-size:13px; color:var(--muted); } .note { font-size:13px; margin:0 0 10px; }
.bar-row { display:grid; grid-template-columns:124px 1fr auto; gap:12px; align-items:center; padding:6px 0; border-radius:6px; }
.bar { height:8px; background:var(--track); border-radius:99px; overflow:hidden; display:block; } .bar-fill { display:block; height:100%; min-width:2px; background:var(--accent); border-radius:99px; } .bar-fill.range { border-radius:99px; }
.bar-label { font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .bar-n { font-size:13.5px; font-weight:600; text-align:right; font-variant-numeric:tabular-nums; min-width:28px; white-space:nowrap; }
.cols { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:10px; height:184px; align-items:end; }
.col { display:grid; grid-template-rows:18px 1fr 20px; height:100%; justify-items:center; align-items:end; gap:5px; min-width:0; }
.col-bar { width:min(100%,44px); background:var(--past); border-radius:8px 8px 2px 2px; min-height:3px; align-self:end; } .col.now .col-bar { background:var(--accent); }
.col-n { font-size:13px; font-weight:650; font-variant-numeric:tabular-nums; } .col-x { font-size:12px; color:var(--muted); white-space:nowrap; } .col.now .col-x { color:var(--accent); font-weight:650; }
.seg { display:flex; gap:3px; height:14px; border-radius:99px; overflow:hidden; margin:6px 0 18px; } .seg-part { min-width:6px; }
.k-queued { background:var(--k-queued); } .k-waiting { background:var(--k-waiting); } .k-talking { background:var(--k-talking); } .k-closed { background:var(--k-closed); }
.legend { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 20px; font-size:14px; } .legend li { display:flex; align-items:center; gap:9px; } .legend strong { margin-left:auto; font-variant-numeric:tabular-nums; }
.dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
[data-tip]:hover .bar-fill,[data-tip]:hover .col-bar { filter:brightness(.92); }
#tip { position:fixed; z-index:9; pointer-events:none; background:var(--ink); color:var(--bg); font-size:12.5px; padding:7px 10px; border-radius:8px; max-width:260px; opacity:0; transition:opacity .08s; }
.listhead { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:8px 0 14px; } .listhead h2 { font-size:22px; font-weight:750; margin:0; letter-spacing:-.03em; }
.controls { display:flex; gap:8px; flex-wrap:wrap; flex:1; justify-content:flex-end; } input,select { font:inherit; font-size:14px; padding:9px 14px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); }
input { flex:1; min-width:180px; max-width:340px; } input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.row { margin-bottom:8px; border-radius:14px; box-shadow:none; transition:box-shadow .15s,border-color .15s; } .row:hover,.row[open] { box-shadow:var(--shadow); border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
summary { list-style:none; cursor:pointer; display:grid; grid-template-columns:minmax(0,1fr) 48px 112px 124px 100px; gap:14px; align-items:center; padding:13px 16px; border-radius:14px; }
summary::-webkit-details-marker { display:none; }
.co { display:flex; align-items:center; gap:12px; min-width:0; } .co-text { display:flex; flex-direction:column; min-width:0; } .co strong { font-weight:650; } .co .muted { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.avatar { width:38px; height:38px; border-radius:50%; background:var(--soft); color:var(--accent); display:grid; place-items:center; font-weight:700; flex-shrink:0; }
.muted { color:var(--muted); } .fit { font-variant-numeric:tabular-nums; font-weight:650; color:var(--muted); text-align:center; font-size:13px; padding:4px 0; border-radius:8px; } .fit.hot { color:var(--pop-ink); background:var(--pop); } .date { color:var(--muted); font-size:12.5px; text-align:right; }
.pill { font-size:12px; font-weight:650; padding:4px 11px; border-radius:999px; background:var(--track); color:var(--ink); justify-self:start; }
.s-rejected,.s-bounced { color:var(--bad); background:color-mix(in srgb,var(--bad) 10%,transparent); }
.s-offer,.s-accepted { color:var(--pop-ink); background:var(--pop); } .s-interviewing,.s-screening { color:var(--ok); background:var(--soft); }
.s-ghosted,.s-withdrawn { color:var(--muted); background:var(--track); } .s-assessment { color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent); }
.steps { display:flex; gap:3px; } .step { width:14px; height:6px; border-radius:3px; background:var(--track); } .step.on { background:var(--accent); }
.detail { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px 20px; padding:8px 16px 18px; border-top:1px solid var(--line); }
.detail h4 { margin:10px 0 4px; font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); font-weight:650; }
a { color:var(--link); font-weight:550; } .tl ul { margin:0; padding-left:16px; } .tl time { color:var(--muted); font-size:12px; margin-right:4px; }
code { font-size:12px; background:var(--track); padding:1px 5px; border-radius:4px; }
.empty { text-align:center; color:var(--muted); padding:44px; background:var(--card); border:1px dashed var(--line); border-radius:16px; }
@media (max-width:1100px) { .tiles { grid-template-columns:repeat(6,minmax(0,1fr)); } .tile { grid-column:span 2; } .tile.hero { grid-column:span 6; min-height:132px; } .tile:nth-last-child(-n+2) { grid-column:span 3; } }
@media (max-width:640px) { main { padding:2px 0 48px; } h1 { font-size:28px; } .sub { margin-bottom:18px; } summary { grid-template-columns:1fr auto; } .fit,.steps,.date { display:none; } .tiles { gap:10px; } .tile { grid-column:span 3; min-height:124px; padding:16px; } .tile:nth-last-child(-n+2) { grid-column:span 3; } .tile:last-child { grid-column:span 6; min-height:0; } .tile-v { font-size:32px; } .hero .tile-v { font-size:46px; } .spark { width:60px; } .panel { padding:18px 16px; } .bar-row { grid-template-columns:100px 1fr auto; } .col-x { font-size:10.5px; } .cols { gap:5px; } input { max-width:none; } }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style></head>
<body><main>
<h1>${e(options.title ?? 'Job Tracker')}</h1>
<p class="sub">Updated ${e(new Date(now).toLocaleString('en-US'))}. Click a row for documents, contacts and timeline.</p>
<section class="tiles">${tiles}</section>
<section class="grid2">
<div class="panel"><h4>Applications sent</h4><p class="lede">Per week, last 8 weeks</p>${weeksHtml}</div>
<div class="panel"><h4>How far applications got</h4><p class="lede">Postings that reached each stage</p>${funnelHtml}</div>
</section>
<section class="grid2">
<div class="panel"><h4>Where things stand</h4><p class="lede">Every tracked posting by its current state</p>${standHtml}</div>
<div class="panel"><h4>Fit scores</h4><p class="lede">How well tracked postings match the resume</p>${fitHtml}</div>
</section>
${options.insights ? insightsHtml(options.insights) : ''}
<div class="listhead"><h2>Applications</h2><div class="controls"><input id="q" type="search" placeholder="Search company, title, contact" aria-label="Search applications"><select id="st" aria-label="Filter by status"><option value="">All statuses</option>${statuses.map((s) => `<option value="${e(s)}">${e(LABEL[s] ?? s)}</option>`).join('')}</select></div></div>
<section id="list">${body || '<div class="empty">No applications yet. Run discovery or add a posting.</div>'}</section>
</main>
<div id="tip" role="tooltip"></div>
<script>
(function(){var q=document.getElementById('q'),st=document.getElementById('st');
function f(){var t=q.value.toLowerCase(),s=st.value;document.querySelectorAll('.row').forEach(function(r){r.style.display=(!t||r.dataset.search.indexOf(t)>-1)&&(!s||r.dataset.status===s)?'':'none'})}
q.addEventListener('input',f);st.addEventListener('change',f);
var tip=document.getElementById('tip');
document.addEventListener('pointermove',function(ev){var el=ev.target.closest&&ev.target.closest('[data-tip]');
if(!el){tip.style.opacity=0;return}tip.textContent=el.getAttribute('data-tip');tip.style.opacity=1;
var x=Math.min(ev.clientX+12,window.innerWidth-tip.offsetWidth-8),y=ev.clientY+16;if(y+tip.offsetHeight>window.innerHeight-8)y=ev.clientY-tip.offsetHeight-10;
tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px'});
document.addEventListener('pointerleave',function(){tip.style.opacity=0});})();
// Inside the command center, document links are opened by the parent page.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="jh-doc:"]');
  if (!a) return;
  e.preventDefault();
  parent.postMessage({ type: 'jh-doc', path: a.getAttribute('href').slice(7) }, '*');
});
</script>
</body></html>
`;
}
