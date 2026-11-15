'use strict';

/**
 * SMS notifications through Twilio's REST API (no SDK dependency).
 *
 * Env (never commit these; put them in app_build/server/.env, which is gitignored):
 *   TWILIO_ACCOUNT_SID       AC...
 *   TWILIO_AUTH_TOKEN        auth token (or an API key secret with TWILIO_API_KEY_SID)
 *   TWILIO_API_KEY_SID       optional SK... key; when set it is the Basic-auth user
 *   TWILIO_FROM_NUMBER       +1555... Twilio number, or
 *   TWILIO_MESSAGING_SERVICE_SID  MG... messaging service
 *   JOBHUNT_SMS_TO           your phone, E.164 (+15551234567)
 *
 * With any of these missing, messages are logged as "dry-run" and not sent.
 */

import type { JobHuntStore, StatusChange } from './store';

export interface SmsConfig {
  accountSid: string;
  authUser: string;
  authSecret: string;
  from?: string;
  messagingServiceSid?: string;
  to: string;
}

export type SmsStatus = 'sent' | 'dry-run' | 'failed' | 'muted' | 'app' | 'held';

export interface SmsSender {
  /** `category` lets the notification rules decide whether this goes out now. See notify.ts. */
  send(body: string, category?: import('./notify').NotifyCategory): Promise<{ status: SmsStatus; providerId: string | null; error: string | null }>;
}

export function smsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmsConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authSecret = env.TWILIO_AUTH_TOKEN?.trim();
  const to = env.JOBHUNT_SMS_TO?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!accountSid || !authSecret || !to || (!from && !messagingServiceSid)) return null;
  return { accountSid, authUser: env.TWILIO_API_KEY_SID?.trim() || accountSid, authSecret, from, messagingServiceSid, to };
}

export function createTwilioSender(config: SmsConfig | null, fetchImpl: typeof fetch = fetch): SmsSender {
  return {
    async send(body: string) {
      if (!config) return { status: 'dry-run', providerId: null, error: null };
      const form = new URLSearchParams({ To: config.to, Body: body });
      if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
      else form.set('From', config.from!);
      try {
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.authUser}:${config.authSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) return { status: 'failed', providerId: null, error: `Twilio ${res.status}: ${json.message ?? 'request failed'}` };
        return { status: 'sent', providerId: json.sid ?? null, error: null };
      } catch (error) {
        return { status: 'failed', providerId: null, error: (error as Error).message };
      }
    },
  };
}

const LABELS: Record<string, string> = {
  saved: 'saved', tailored: 'resume + cover letter ready', applied: 'applied', acknowledged: 'application received', assessment: 'ASSESSMENT', bounced: 'EMAIL BOUNCED', screening: 'screening',
  interviewing: 'interviewing', offer: 'OFFER', accepted: 'accepted', rejected: 'rejected', withdrawn: 'withdrawn', ghosted: 'no response (ghosted)',
};

export function formatStatusSms(change: StatusChange): string {
  const { job, event } = change;
  const head = `[Job ${change.application.id.slice(0, 4)}] ${job.company}, ${job.title}`;
  const move = event.fromStatus ? `${LABELS[event.fromStatus] ?? event.fromStatus} to ${LABELS[event.toStatus] ?? event.toStatus}` : LABELS[event.toStatus];
  const reason = event.reason ? ` (${event.reason})` : '';
  const body = `${head}: ${move}${reason}`;
  // Keep within 2 SMS segments.
  return body.length > 300 ? `${body.slice(0, 297)}...` : body;
}

/** Text the user on every status change and log the result. */
export function attachSmsNotifier(store: JobHuntStore, sender: SmsSender): () => void {
  return store.onStatusChange(async (change) => {
    const body = formatStatusSms(change);
    const major = ['acknowledged', 'assessment', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'bounced'].includes(change.event.toStatus);
    const result = await sender.send(body, major ? 'status_major' : 'status_minor');
    store.logNotification({ applicationId: change.application.id, channel: 'sms', body, ...result });
    if (result.status === 'failed') console.error('[jobhunt] SMS failed:', result.error);
  });
}

// ── Inbound replies ─────────────────────────────────────────────────────────

export interface InboundSms {
  sid: string;
  from: string;
  body: string;
  dateSent: number;
}

export interface SmsInbox {
  /** Inbound messages from the user's phone to the Twilio number since `since` (ms). */
  list(since: number): Promise<InboundSms[]>;
}

/**
 * Polls Twilio's Messages list for replies, so no public webhook URL is
 * needed on the user's computer. Only messages from JOBHUNT_SMS_TO count.
 */
export function createTwilioInbox(config: SmsConfig | null, fetchImpl: typeof fetch = fetch): SmsInbox | null {
  if (!config || !config.from) return null;
  return {
    async list(since: number) {
      const q = new URLSearchParams({ To: config.from!, From: config.to, PageSize: '50' });
      q.set('DateSent>', new Date(since - 86_400_000).toISOString().slice(0, 10));
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json?${q}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${config.authUser}:${config.authSecret}`).toString('base64')}` },
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? 'list failed'}`);
      return (json.messages ?? [])
        .filter((m: any) => m.direction === 'inbound' && m.from === config.to)
        .map((m: any) => ({ sid: m.sid, from: m.from, body: String(m.body ?? ''), dateSent: Date.parse(m.date_sent ?? m.date_created ?? '') || 0 }))
        .filter((m: InboundSms) => m.dateSent >= since);
    },
  };
}
