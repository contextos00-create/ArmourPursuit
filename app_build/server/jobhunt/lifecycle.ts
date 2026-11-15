'use strict';

/** Stale sweeper and the evening digest text. */

import type { JobHuntStore } from './store';
import type { SmsSender } from './sms';

const DAY = 86_400_000;

/** Move applications with no activity for `days` from applied/acknowledged to ghosted. */
export async function sweepStale(store: JobHuntStore, options: { days?: number; now?: number } = {}) {
  const days = options.days ?? 30;
  const now = options.now ?? Date.now();
  const moved: string[] = [];
  for (const a of store.listApplications()) {
    if (!['applied', 'acknowledged'].includes(a.status)) continue;
    if (now - a.updatedAt < days * DAY) continue;
    await store.setStatus(a.id, 'ghosted', { source: 'system', reason: `no reply in ${days} days, consider a follow-up` });
    moved.push(a.id);
  }
  return moved;
}

export function buildDigest(store: JobHuntStore, options: { since?: number; now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const since = options.since ?? now - DAY;
  const apps = store.listApplications();
  const newJobs = apps.filter((a) => a.createdAt >= since);
  const byRoute = (r: string) => newJobs.filter((a) => a.job.fitRoute === r).length;
  const waiting = apps.filter((a) => a.job.fitRoute === 'needs_approval' && a.status === 'saved');
  const changes = apps.flatMap((a) => store.history(a.id).filter((e) => e.createdAt >= since && e.fromStatus).map((e) => ({ a, e })));
  const count = (s: string) => changes.filter((c) => c.e.toStatus === s).length;
  const active = apps.filter((a) => ['applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer'].includes(a.status)).length;

  const lines = [`[Job] Daily digest`];
  lines.push(`New postings: ${newJobs.length} (${byRoute('auto_tailor')} tailored, ${byRoute('needs_approval')} need OK, ${byRoute('filtered_out')} filtered)`);
  const moves = ['applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer', 'rejected', 'bounced', 'ghosted']
    .map((s) => [s, count(s)] as const).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
  lines.push(`Today: ${moves.length ? moves.join(', ') : 'no status changes'}`);
  lines.push(`Active applications: ${active}`);
  if (waiting.length) {
    lines.push(`Waiting on your OK (reply YES <code>):`);
    for (const a of waiting.slice(0, 5)) lines.push(`${a.id.slice(0, 4)} ${a.job.company}, ${a.job.title} (fit ${a.job.fitScore})`);
    if (waiting.length > 5) lines.push(`+${waiting.length - 5} more`);
  }
  const body = lines.join('\n');
  return body.length > 1500 ? `${body.slice(0, 1497)}...` : body;
}

export async function sendDigest(store: JobHuntStore, sms: SmsSender, options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  const last = Number(store.getKv('digest_last_sent') ?? 0);
  const body = buildDigest(store, { since: last || now - DAY, now });
  const sent = await sms.send(body, 'digest');
  store.logNotification({ applicationId: null, channel: 'sms', body, ...sent });
  store.setKv('digest_last_sent', String(now));
  return body;
}
