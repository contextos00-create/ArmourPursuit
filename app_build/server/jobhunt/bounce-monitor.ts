'use strict';

/**
 * Polls the mailbox for bounce-backs, ties each one to an application, flags
 * it as `bounced` (which fires the SMS notifier), and texts the user about
 * bounces it could not match. Each mailbox message is processed once.
 */

import { detectBounce } from './bounce';
import { BOUNCE_QUERY, type MailSource } from './gmail';
import type { JobHuntStore } from './store';
import type { SmsSender } from './sms';
import { STATUS_TRANSITIONS, type Application } from './types';

export interface BounceScanResult {
  scanned: number;
  bounces: number;
  flagged: { applicationId: string; recipient: string | null }[];
  unmatched: { recipient: string | null; messageId: string }[];
  errors: string[];
}

function pickApplication(store: JobHuntStore, messageIds: string[], recipients: string[]): Application | null {
  for (const id of messageIds) {
    const app = store.findApplicationByMessageId(id);
    if (app) return app;
  }
  for (const r of recipients) {
    const candidates = store.findApplicationsByEmail(r);
    // Prefer an application that can still move to bounced (most recent first).
    const active = candidates.find((a) => STATUS_TRANSITIONS[a.status].includes('bounced'));
    if (active) return active;
    if (candidates[0]) return candidates[0];
  }
  return null;
}

export async function scanForBounces(
  store: JobHuntStore,
  mail: MailSource,
  sms: SmsSender,
  options: { query?: string; max?: number } = {},
): Promise<BounceScanResult> {
  const result: BounceScanResult = { scanned: 0, bounces: 0, flagged: [], unmatched: [], errors: [] };
  const ids = await mail.search(options.query ?? BOUNCE_QUERY, options.max ?? 50);
  for (const id of ids) {
    if (store.hasEmailEvent('gmail', id)) continue;
    result.scanned++;
    let raw: string;
    try {
      raw = await mail.getRaw(id);
    } catch (error) {
      result.errors.push(`${id}: ${(error as Error).message}`);
      continue;
    }
    const info = detectBounce(raw, mail.ownAddresses());
    if (!info.isBounce) {
      // Remember non-bounces too so they are not re-downloaded every poll.
      store.recordEmailEvent({ provider: 'gmail', providerMessageId: id, kind: 'bounce', applicationId: null, bouncedRecipient: null, diagnostic: 'not a permanent bounce' });
      continue;
    }
    result.bounces++;
    const recipient = info.recipients[0] ?? null;
    const app = pickApplication(store, info.originalMessageIds, info.recipients);
    const diagnostic = [info.status, info.diagnostic].filter(Boolean).join(' ').slice(0, 300) || null;
    store.recordEmailEvent({ provider: 'gmail', providerMessageId: id, kind: 'bounce', applicationId: app?.id ?? null, bouncedRecipient: recipient, diagnostic });

    if (app && STATUS_TRANSITIONS[app.status].includes('bounced')) {
      await store.setStatus(app.id, 'bounced', { source: 'email-monitor', reason: `email to ${recipient ?? 'recipient'} bounced${info.status ? `, ${info.status}` : ''}` });
      result.flagged.push({ applicationId: app.id, recipient });
    } else {
      // Unmatched, or the application is already closed/bounced: still tell the user.
      const job = app ? store.getJob(app.jobId) : null;
      const body = app
        ? `[Job] Bounce for ${job?.company ?? 'an application'} (${recipient ?? 'unknown address'}), already ${app.status}.`
        : `[Job] An email to ${recipient ?? 'an unknown address'} bounced and is not linked to any application.${info.subject ? ` Subject: ${info.subject.slice(0, 80)}` : ''}`;
      const sent = await sms.send(body, 'email');
      store.logNotification({ applicationId: app?.id ?? null, channel: 'sms', body, ...sent });
      if (!app) result.unmatched.push({ recipient, messageId: id });
    }
  }
  store.setKv('bounce_monitor_last_run', String(Date.now()));
  return result;
}

/** Run scanForBounces on an interval. Returns a stop function. */
export function startBounceMonitor(
  store: JobHuntStore,
  mail: MailSource,
  sms: SmsSender,
  options: { intervalMs?: number; onResult?: (r: BounceScanResult) => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await scanForBounces(store, mail, sms);
      options.onResult?.(r);
    } catch (error) {
      console.error('[jobhunt] bounce scan failed:', (error as Error).message);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
