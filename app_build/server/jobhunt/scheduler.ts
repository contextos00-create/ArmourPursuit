'use strict';

/**
 * One long-running loop for everything recurring. Ticks every minute and runs
 * each job when it is due, recording last-run times in the store so a restart
 * does not repeat work:
 *   text replies   every minute
 *   inbox + bounces every 5 minutes (needs Gmail)
 *   discovery      every hour between 7 AM and 9 PM local (skipped while paused), so top matches text fast
 *   follow-through every minute: interview reminders, thank-you and 7-day follow-up drafts
 *   stale sweep    once a day after 2 AM
 *   digest         once a day at 6:30 PM local
 *   dashboard      rewritten after any job runs
 */

import type { JobHunt } from './index';

export type { JobHunt };
import { isPaused } from './replies';

export interface ScheduleOptions {
  now?: () => Date;
  log?: (line: string) => void;
  discoveryEveryMinutes?: number;
  inboxEveryMinutes?: number;
  digestAt?: { hour: number; minute: number };
  activeHours?: [number, number];
}

function minutesSince(jh: JobHunt, key: string, now: Date): number {
  const last = Number(jh.store.getKv(`sched_${key}`) ?? 0);
  return last ? (now.getTime() - last) / 60_000 : Infinity;
}

function sameLocalDay(a: number, b: Date) {
  const d = new Date(a);
  return d.getFullYear() === b.getFullYear() && d.getMonth() === b.getMonth() && d.getDate() === b.getDate();
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Run whatever is due right now. Exported for tests. */
export async function runDue(jh: JobHunt, opts: ScheduleOptions = {}): Promise<string[]> {
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? ((l) => console.log(`[jobhunt] ${l}`));
  const ran: string[] = [];
  // Saved schedule settings (command center) apply unless the caller passed its own.
  let saved: any = {};
  try {
    saved = (jh.readPreferences() as any).schedule ?? {};
  } catch {
    saved = {};
  }
  opts = { discoveryEveryMinutes: saved.discoveryEveryMinutes, inboxEveryMinutes: saved.inboxEveryMinutes, digestAt: saved.digestAt, activeHours: saved.activeHours, ...definedOnly(opts) };
  const mark = (key: string) => jh.store.setKv(`sched_${key}`, String(now.getTime()));
  const attempt = async (key: string, work: () => Promise<string>) => {
    mark(key);
    try {
      log(`${key}: ${await work()}`);
    } catch (error) {
      log(`${key} failed: ${(error as Error).message}`);
    }
    ran.push(key);
  };

  if (jh.hasSmsInbox() && minutesSince(jh, 'replies', now) >= 1) {
    await attempt('replies', async () => `${await jh.processReplies()} handled`);
  }
  if (jh.hasMail() && minutesSince(jh, 'inbox', now) >= (opts.inboxEveryMinutes ?? 5)) {
    await attempt('inbox', async () => {
      const b = await jh.scanBounces();
      const i = await jh.scanInbox();
      return `${b.bounces} bounces, ${i.updated.length} status updates, ${i.unmatched.length} unmatched`;
    });
  }
  const [startH, endH] = opts.activeHours ?? [7, 21];
  const hour = now.getHours();
  if (!isPaused(jh.store) && hour >= startH && hour < endH && minutesSince(jh, 'discover', now) >= (opts.discoveryEveryMinutes ?? 60)) {
    await attempt('discover', async () => {
      const r = await jh.discover();
      return `${r.fetched} fetched, ${r.fresh} new, ${r.added.length} added, ${r.deferred} deferred, ${r.filteredOut} filtered${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`;
    });
  }
  try {
    const followed = await jh.runFollowups();
    if (followed.length) {
      log(`followups: ${followed.join(', ')}`);
      ran.push('followups');
    }
  } catch (error) {
    log(`followups failed: ${(error as Error).message}`);
  }
  const lastSweep = Number(jh.store.getKv('sched_sweep') ?? 0);
  if (hour >= 2 && !sameLocalDay(lastSweep, now)) {
    await attempt('sweep', async () => `${(await jh.sweepStale()).length} marked ghosted`);
  }
  const at = opts.digestAt ?? { hour: 18, minute: 30 };
  try {
    if (jh.heldNotifications()) await jh.flushNotifications();
  } catch (error) {
    log(`held notifications failed: ${(error as Error).message}`);
  }
  const lastDigest = Number(jh.store.getKv('sched_digest') ?? 0);
  if (hour * 60 + now.getMinutes() >= at.hour * 60 + at.minute && !sameLocalDay(lastDigest, now)) {
    await attempt('digest', async () => {
      await jh.sendDigest();
      return 'sent';
    });
  }
  if (ran.length || !jh.store.getKv('sched_dashboard')) {
    try {
      jh.writeDashboard();
      mark('dashboard');
    } catch (error) {
      log(`dashboard failed: ${(error as Error).message}`);
    }
  }
  return ran;
}

export function startScheduler(jh: JobHunt, opts: ScheduleOptions = {}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDue(jh, opts);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
