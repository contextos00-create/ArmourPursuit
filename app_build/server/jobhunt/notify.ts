'use strict';

/**
 * Notification rules. Every text the pipeline sends goes through gateSms,
 * which applies the person's choices: master switch, texting on or off,
 * which kinds they want, and quiet hours. Nothing here adds a new way to
 * send; it only decides whether an existing text goes out now, later, or
 * stays in the app's own feed.
 */

import type { SmsSender } from './sms';
import type { JobHuntStore } from './store';

export const NOTIFY_CATEGORIES = ['top_match', 'new_posting', 'status_major', 'status_minor', 'interview', 'drafts', 'apply', 'email', 'digest'] as const;
/** 'reply' answers something the person just texted, so it always goes out. */
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number] | 'reply';

export const CATEGORY_LABEL: Record<(typeof NOTIFY_CATEGORIES)[number], string> = {
  top_match: 'Top matches',
  new_posting: 'Other new postings',
  status_major: 'Replies, assessments, interviews, offers, rejections',
  status_minor: 'Every other status change',
  interview: 'Interview times and reminders',
  drafts: 'Follow-up and thank-you drafts ready',
  apply: 'Form fill results and problems',
  email: 'Bounced and unmatched emails',
  digest: 'Daily summary',
};

const URGENT: NotifyCategory[] = ['top_match', 'interview'];
const HELD_KEY = 'notify_held';

export interface NotifySettings {
  enabled: boolean;
  sms: boolean;
  browser: boolean;
  off: string[];
  quiet: boolean;
  quietStart: number;
  quietEnd: number;
  quietUrgent: boolean;
}

export function notifySettings(prefs: any): NotifySettings {
  const n = prefs?.notifications ?? {};
  const hour = (v: unknown, fallback: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x >= 0 && x <= 23 ? x : fallback;
  };
  return {
    enabled: n.enabled !== false,
    sms: n.sms !== false,
    browser: n.browser === true,
    off: Array.isArray(n.off) ? n.off.filter((c: unknown) => (NOTIFY_CATEGORIES as readonly string[]).includes(c as string)) : [],
    quiet: n.quiet === true,
    quietStart: hour(n.quietStart, 21),
    quietEnd: hour(n.quietEnd, 8),
    quietUrgent: n.quietUrgent !== false,
  };
}

/** True when the local hour falls inside the quiet window (which may wrap past midnight). */
export function inQuietHours(s: Pick<NotifySettings, 'quiet' | 'quietStart' | 'quietEnd'>, now: Date): boolean {
  if (!s.quiet || s.quietStart === s.quietEnd) return false;
  const h = now.getHours();
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

export interface GatedSender extends SmsSender {
  /** Send what was held during quiet hours. Returns how many texts went out. */
  flush(): Promise<number>;
  held(): number;
}

export function gateSms(inner: SmsSender, deps: { store: JobHuntStore; prefs: () => any; now?: () => number }): GatedSender {
  const now = () => new Date(deps.now ? deps.now() : Date.now());
  const readHeld = (): { body: string; at: number }[] => {
    try {
      const v = JSON.parse(deps.store.getKv(HELD_KEY) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return {
    async send(body, category) {
      const s = notifySettings(deps.prefs());
      if (category && category !== 'reply') {
        if (!s.enabled || s.off.includes(category)) return { status: 'muted', providerId: null, error: null };
        if (!s.sms) return { status: 'app', providerId: null, error: null };
        if (inQuietHours(s, now()) && !(s.quietUrgent && URGENT.includes(category))) {
          deps.store.setKv(HELD_KEY, JSON.stringify([...readHeld(), { body, at: now().getTime() }].slice(-50)));
          return { status: 'held', providerId: null, error: null };
        }
      }
      return inner.send(body, category);
    },
    held: () => readHeld().length,
    async flush() {
      const s = notifySettings(deps.prefs());
      const held = readHeld();
      if (!held.length || inQuietHours(s, now())) return 0;
      deps.store.setKv(HELD_KEY, '[]');
      if (!s.enabled || !s.sms) return 0;
      const first = held.slice(0, 3).map((h) => h.body);
      if (held.length > 3) first.push(`[Job] ${held.length - 3} more updates came in during quiet hours. Open the app to see them.`);
      let sent = 0;
      for (const body of first) {
        const result = await inner.send(body, 'reply');
        deps.store.logNotification({ applicationId: null, channel: 'sms', body: `After quiet hours: ${body}`, ...result });
        if (result.status === 'sent') sent++;
      }
      return sent;
    },
  };
}
