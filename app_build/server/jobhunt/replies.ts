'use strict';

/**
 * Text-message control. The person replies to a notification:
 *   YES abcd     tailor a needs-approval posting (code = first 4 of the id)
 *   SKIP abcd    withdraw it
 *   APPLIED abcd mark as applied
 *   ANSWER abcd 2 Yes   answer question 2 from an assisted-apply run (saved for reuse)
 *   STATUS       counts of active applications
 *   PAUSE / RESUME  stop or restart discovery, tailoring and assisted apply
 *   HELP
 * A bare YES or SKIP applies to the most recent posting waiting for approval.
 */

import type { JobHuntStore } from './store';
import type { SmsInbox, SmsSender } from './sms';
import type { Application, JobPosting } from './types';

export interface ReplyDeps {
  store: JobHuntStore;
  sms: SmsSender;
  approve: (applicationId: string) => Promise<unknown>;
  /** Save an answer to pending application question n. Returns the question text. */
  answer?: (applicationId: string, n: number, answer: string) => string;
}

export const PAUSE_KEY = 'paused';

export function isPaused(store: JobHuntStore): boolean {
  return store.getKv(PAUSE_KEY) === '1';
}

function find(store: JobHuntStore, code: string | undefined): { app?: Application & { job: JobPosting }; error?: string } {
  const apps = store.listApplications();
  if (!code) {
    const waiting = apps.filter((a) => a.status === 'saved' && a.job.fitRoute === 'needs_approval');
    return waiting[0] ? { app: waiting[0] } : { error: 'Nothing is waiting for approval.' };
  }
  const matches = apps.filter((a) => a.id.toLowerCase().startsWith(code.toLowerCase()));
  if (matches.length === 1) return { app: matches[0] };
  return { error: matches.length ? `Code ${code} matches ${matches.length} postings, send more characters.` : `No posting with code ${code}.` };
}

export async function handleReply(text: string, deps: ReplyDeps): Promise<string> {
  const [rawCmd, code] = text.trim().split(/\s+/);
  const cmd = (rawCmd ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const { store } = deps;
  try {
    switch (cmd) {
      case 'Y':
      case 'YES':
      case 'OK':
      case 'APPROVE': {
        const { app, error } = find(store, code);
        if (!app) return error!;
        await deps.approve(app.id);
        return `Tailoring ${app.job.company}, ${app.job.title}.`;
      }
      case 'N':
      case 'NO':
      case 'SKIP': {
        const { app, error } = find(store, code);
        if (!app) return error!;
        await store.setStatus(app.id, 'withdrawn', { source: 'user', reason: 'skipped by text' });
        return `Skipped ${app.job.company}, ${app.job.title}.`;
      }
      case 'APPLIED': {
        const { app, error } = find(store, code);
        if (!app) return error!;
        await store.setStatus(app.id, 'applied', { source: 'user', reason: 'marked by text' });
        return `Marked ${app.job.company} as applied.`;
      }
      case 'ANSWER': {
        const [, , nRaw, ...words] = text.trim().split(/\s+/);
        const n = Number(nRaw);
        if (!code || !Number.isInteger(n) || n < 1 || !words.length || !deps.answer) return 'Format: ANSWER code number your answer';
        const { app, error } = find(store, code);
        if (!app) return error!;
        const q = deps.answer(app.id, n, words.join(' '));
        return `Saved for "${q.slice(0, 60)}". Rerun apply ${code} to fill it.`;
      }
      case 'STATUS': {
        const counts = new Map<string, number>();
        for (const a of store.listApplications()) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
        const line = [...counts].map(([s, n]) => `${n} ${s}`).join(', ') || 'no applications yet';
        return `${line}${isPaused(store) ? '. Automation is PAUSED.' : ''}`;
      }
      case 'PAUSE':
      case 'STOP':
        store.setKv(PAUSE_KEY, '1');
        return 'Paused discovery, tailoring and assisted apply. Text RESUME to restart.';
      case 'RESUME':
      case 'START':
        store.setKv(PAUSE_KEY, '0');
        return 'Resumed.';
      default:
        return 'Commands: YES code, SKIP code, APPLIED code, ANSWER code n text, STATUS, PAUSE, RESUME.';
    }
  } catch (error) {
    return `Could not do that: ${(error as Error).message.slice(0, 120)}`;
  }
}

/** Fetch new replies, run them, and answer each by text. */
export async function processReplies(inbox: SmsInbox, deps: ReplyDeps): Promise<number> {
  const since = Number(deps.store.getKv('sms_replies_since') ?? Date.now() - 3_600_000);
  const messages = (await inbox.list(since)).sort((a, b) => a.dateSent - b.dateSent);
  let handled = 0;
  let latest = since;
  for (const m of messages) {
    latest = Math.max(latest, m.dateSent);
    const key = `sms_reply_${m.sid}`;
    if (deps.store.getKv(key)) continue;
    deps.store.setKv(key, '1');
    const answer = await handleReply(m.body, deps);
    const sent = await deps.sms.send(`[Job] ${answer}`, 'reply');
    deps.store.logNotification({ applicationId: null, channel: 'sms', body: `[Job] ${answer}`, ...sent });
    handled++;
  }
  deps.store.setKv('sms_replies_since', String(latest));
  return handled;
}
