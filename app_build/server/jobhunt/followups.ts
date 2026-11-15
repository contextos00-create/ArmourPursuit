'use strict';

/**
 * Follow-through after applying:
 *   outreach    a short note to the hiring contact right after applying
 *   follow-up   a nudge when an application has gone 7 days without a reply
 *   thank-you   the same day as an interview (after it ends when the time is known)
 *   interviews  times pulled from invite emails (.ics first, then the text),
 *               added to Google Calendar, with a text 1 hour before
 *
 * Every message is a draft in the reply queue (responses.ts), written by the
 * rules the person set in the reply workshop. Nothing is sent until the
 * person presses Send on that one message.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseMime, type MimePart } from './bounce';
import type { MailSource } from './gmail';
import type { SmsSender } from './sms';
import type { JobHuntStore } from './store';
import { announceDue, bestContact, queueReply, runReplyFollowups } from './responses';
import { dueReminders, loadPlan } from './plan';
import type { MasterResume } from './types';

const DAY = 86_400_000;

// ── Interview times ────────────────────────────────────────────────────────

export interface InterviewTime {
  start: number;
  end: number;
  location: string | null;
  source: 'ics' | 'text';
}

function findPart(part: MimePart, type: RegExp): MimePart | null {
  if (type.test(part.headers['content-type'] ?? '')) return part;
  for (const p of part.parts) {
    const hit = findPart(p, type);
    if (hit) return hit;
  }
  return null;
}

/** UTC milliseconds for a wall-clock time in an IANA zone. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asZone = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return guess - (asZone - guess);
}

function icsDate(value: string, tzid: string | null, fallbackTz: string): number | null {
  const m = value.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi);
  return zonedToUtc(+y, +mo, +d, +h, +mi, tzid ?? fallbackTz);
}

export function parseIcs(ics: string, fallbackTz = 'America/New_York'): InterviewTime | null {
  const lines = ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const get = (name: string) => {
    const line = lines.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
    if (!line) return null;
    const tzid = line.match(/TZID=([^;:]+)/)?.[1] ?? null;
    return { value: line.slice(line.indexOf(':') + 1), tzid };
  };
  const s = get('DTSTART');
  if (!s) return null;
  const start = icsDate(s.value, s.tzid, fallbackTz);
  if (start == null) return null;
  const e = get('DTEND');
  const end = (e && icsDate(e.value, e.tzid, fallbackTz)) || start + 30 * 60_000;
  const loc = get('LOCATION')?.value.replace(/\\,/g, ',').replace(/\\n/g, ' ') || null;
  return { start, end, location: loc, source: 'ics' };
}

const ZONES: Record<string, string> = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A confirmed time written in prose, e.g. "Tuesday, November 18 at 2:00 PM ET"
 * or "11/18/2026 at 2pm EST". Returns null for anything ambiguous, such as a
 * list of options to pick from.
 */
export function parseTextTime(text: string, now: number, fallbackTz = 'America/New_York'): InterviewTime | null {
  const t = text.replace(/\s+/g, ' ');
  const time = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)\\s*(?:\\(?\\b(et|est|edt|eastern|ct|cst|cdt|central|mt|mst|mdt|mountain|pt|pst|pdt|pacific)\\b)?';
  const named = new RegExp(`\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?,? (?:at |@ |from )?${time}`, 'gi');
  const numeric = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?,? (?:at |@ |from )?${time}`, 'gi');
  const hits: number[] = [];
  let tz = fallbackTz;
  const add = (mo: number, d: number, y: number | null, h: number, mi: number, ap: string, zone?: string) => {
    let hour = h % 12 + (/p/i.test(ap) ? 12 : 0);
    if (hour === 24) hour = 12;
    if (zone) tz = ZONES[zone.toLowerCase()] ?? tz;
    let year = y ?? new Date(now).getUTCFullYear();
    if (year < 100) year += 2000;
    let at = zonedToUtc(year, mo, d, hour, mi, tz);
    if (!y && at < now - DAY) at = zonedToUtc(year + 1, mo, d, hour, mi, tz);
    hits.push(at);
  };
  for (const m of t.matchAll(named)) add(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, +m[2], m[3] ? +m[3] : null, +m[4], +(m[5] ?? 0), m[6], m[7]);
  for (const m of t.matchAll(numeric)) add(+m[1], +m[2], m[3] ? +m[3] : null, +m[4], +(m[5] ?? 0), m[6], m[7]);
  const unique = [...new Set(hits)].filter((h) => h > now - DAY);
  if (unique.length !== 1) return null; // several options or none: let the person handle it
  const dur = t.match(/(\d{2,3})[- ]min(ute)?s?\b/i);
  const start = unique[0];
  return { start, end: start + (dur ? Number(dur[1]) : 30) * 60_000, location: t.match(/https:\/\/[^\s)>"]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s)>"]*/i)?.[0] ?? null, source: 'text' };
}

export function interviewTimeFromEmail(raw: string, now: number): InterviewTime | null {
  const root = parseMime(raw);
  const cal = findPart(root, /text\/calendar|application\/ics/i);
  if (cal) {
    const parsed = parseIcs(cal.body);
    if (parsed) return parsed;
  }
  const text = findPart(root, /text\/plain/i)?.body ?? root.body;
  return parseTextTime(text, now);
}

// ── Drafts ─────────────────────────────────────────────────────────────────

export interface FollowupDeps {
  store: JobHuntStore;
  sms: SmsSender;
  mail: MailSource | null;
  master: () => MasterResume;
  outputDir: string | null;
  /** Saved preferences, for the reply rules. */
  prefs?: () => any;
  now?: () => number;
}

/** Call on every status change. */
export async function onStatusChanged(deps: FollowupDeps, applicationId: string, to: string) {
  const app = deps.store.listApplications().find((a) => a.id === applicationId);
  if (!app) return;
  const contact = bestContact(deps.store, app);
  if (to === 'applied' && contact) {
    await queueReply(deps, app, 'outreach', { key: `outreach:${app.id}`, reason: `You applied, and ${contact.name ?? contact.email} is on file as a contact.` });
  }
}

/** Record an interview time, add it to the calendar, and schedule reminders. */
export async function recordInterview(deps: FollowupDeps, applicationId: string, when: InterviewTime) {
  const app = deps.store.listApplications().find((a) => a.id === applicationId);
  if (!app) return null;
  deps.store.setKv(`interview_${app.id}`, JSON.stringify(when));
  let calendar = 'not added (no calendar access)';
  const cal = deps.mail?.calendar;
  if (cal) {
    try {
      const existing = await cal.findEvents(new Date(when.start - 10 * 60_000).toISOString(), new Date(when.start + 10 * 60_000).toISOString());
      if (existing.length) calendar = 'already on the calendar';
      else {
        await cal.createEvent({
          summary: `Interview: ${app.job.company}, ${app.job.title}`, start: new Date(when.start).toISOString(), end: new Date(when.end).toISOString(),
          location: when.location, description: [app.job.url, 'Prep pack is linked on the job dashboard.'].filter(Boolean).join('\n'),
        });
        calendar = 'added to Google Calendar';
      }
    } catch (error) {
      calendar = `calendar failed: ${(error as Error).message.slice(0, 60)}`;
    }
  }
  const at = new Date(when.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const body = `[Job ${app.id.slice(0, 4)}] Interview with ${app.job.company}: ${at} ET, ${calendar}. I'll text you an hour before.`;
  const sent = await deps.sms.send(body, 'interview');
  deps.store.logNotification({ applicationId: app.id, channel: 'sms', body, ...sent });
  return calendar;
}

/**
 * Run every scheduler tick. Sends the 1-hour interview reminder and writes the
 * drafts that are due: thank-you notes and follow-ups. Drafts only.
 */
export async function runFollowups(deps: FollowupDeps): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const done: string[] = [];
  for (const app of deps.store.listApplications()) {
    const raw = deps.store.getKv(`interview_${app.id}`);
    if (raw) {
      const when: InterviewTime = JSON.parse(raw);
      if (now >= when.start - 65 * 60_000 && now < when.start && !deps.store.getKv(`interview_reminded_${app.id}_${when.start}`)) {
        deps.store.setKv(`interview_reminded_${app.id}_${when.start}`, String(now));
        const body = `[Job ${app.id.slice(0, 4)}] Interview with ${app.job.company} in about an hour.${when.location ? ` ${when.location}` : ''} Prep pack is on the dashboard.`;
        const sent = await deps.sms.send(body, 'interview');
        deps.store.logNotification({ applicationId: app.id, channel: 'sms', body, ...sent });
        done.push(`reminder ${app.id.slice(0, 8)}`);
      }
      if (now >= when.end && now < when.end + DAY) {
        const draft = await queueReply(deps, app, 'thankyou', { key: `thankyou:${app.id}:${when.start}`, reason: `Your interview on ${new Date(when.start).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })} ended.`, from: when.end });
        if (draft) done.push(`thank-you ${app.id.slice(0, 8)}`);
      }
    } else if (app.status === 'interviewing' && now - app.updatedAt < DAY) {
      // Interview stage with no known time: draft it now, to send after the interview.
      const draft = await queueReply(deps, app, 'thankyou', { key: `thankyou:${app.id}:status`, reason: 'This application moved to the interview stage. Send it after you talk.', from: now });
      if (draft) done.push(`thank-you ${app.id.slice(0, 8)}`);
    }
  }
  // Dates the person added to a game plan: reminders ahead, and a thank-you draft after.
  const apps = deps.store.listApplications();
  for (const r of dueReminders(deps.store, apps, now)) {
    // The invite email already schedules its own one-hour text for the same time.
    const invite = deps.store.getKv(`interview_${r.applicationId}`);
    if (invite && r.key.endsWith(`_${JSON.parse(invite).start}_60`)) continue;
    deps.store.setKv(r.key, String(now));
    const sent = await deps.sms.send(r.body, 'interview');
    deps.store.logNotification({ applicationId: r.applicationId, channel: 'sms', body: r.body, ...sent });
    done.push(`plan reminder ${r.applicationId.slice(0, 8)}`);
  }
  for (const app of apps) {
    if (!deps.store.getKv(`plan_${app.id}`)) continue;
    for (const d of loadPlan(deps.store, app.id).dates) {
      const end = d.at + d.minutes * 60_000;
      if ((d.kind !== 'screen' && d.kind !== 'interview') || now < end || now >= end + DAY) continue;
      const draft = await queueReply(deps, app, 'thankyou', { key: `thankyou:${app.id}:${d.at}`, reason: `Your ${d.kind === 'screen' ? 'phone screen' : 'interview'} on ${new Date(d.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ended.`, from: end });
      if (draft) done.push(`thank-you ${app.id.slice(0, 8)}`);
    }
  }
  done.push(...(await runReplyFollowups(deps)));
  done.push(...(await announceDue(deps)));
  return done;
}

export function hasFile(dir: string | null, name: string) {
  return !!dir && existsSync(join(dir, name));
}
