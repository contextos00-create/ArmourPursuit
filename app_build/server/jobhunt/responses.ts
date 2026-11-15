'use strict';

/**
 * Reply workshop: the rules for when a reply or follow-up is drafted, what it
 * says, and the queue the person works through.
 *
 * Every message here is a draft. Rules write drafts and schedule follow-ups;
 * nothing is emailed until the person presses Send on that one message.
 * There is no code path that sends on a timer.
 */

import { randomUUID } from 'node:crypto';
import type { InterviewTime } from './followups';
import type { MailSource } from './gmail';
import { parseEmail, senderContact } from './inbox';
import type { NotifyCategory } from './notify';
import type { SmsSender } from './sms';
import type { JobHuntStore } from './store';
import { matchesTerm } from './synonyms';
import type { Application, ApplicationStatus, JobPosting, MasterResume } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type App = Application & { job: JobPosting };

export const REPLY_KINDS = ['outreach', 'confirmation', 'assessment', 'interview', 'rejection', 'thankyou', 'followup'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export interface ReplyRule {
  on: boolean;
  /** Hours to wait after the trigger before the draft is ready. */
  delayHours: number;
  subject: string;
  body: string;
}

export interface ReplyConfig {
  /** Master switch. Off: no reply or follow-up is drafted. */
  enabled: boolean;
  rules: Record<ReplyKind, ReplyRule>;
  followup: {
    /** Days of silence after applying before the first follow-up. */
    firstDays: number;
    /** Days between later follow-ups. */
    everyDays: number;
    /** Most follow-ups per application. 0 turns them off. */
    max: number;
    /** Hold a follow-up that lands on a weekend until Monday. */
    weekdaysOnly: boolean;
  };
}

export const KIND_INFO: Record<ReplyKind, { label: string; when: string; delay: string; inbound: boolean }> = {
  outreach: { label: 'Intro note', when: 'You mark an application as sent and a contact with an email is on file.', delay: 'after you apply', inbound: false },
  confirmation: { label: 'Reply to a receipt', when: 'A person (not a no-reply address) confirms they got your application.', delay: 'after their email arrives', inbound: true },
  assessment: { label: 'Reply to an assessment', when: 'A person sends a test or take-home.', delay: 'after their email arrives', inbound: true },
  interview: { label: 'Reply to an interview invite', when: 'A person asks to schedule a call or confirms an interview time.', delay: 'after their email arrives', inbound: true },
  rejection: { label: 'Reply to a rejection', when: 'A person tells you they are not moving forward.', delay: 'after their email arrives', inbound: true },
  thankyou: { label: 'Thank-you note', when: 'An interview ends (or the application moves to interviewing with no time on file).', delay: 'after the interview ends', inbound: false },
  followup: { label: 'Follow-up', when: 'An application has had no reply for the number of days set below.', delay: 'after the wait is over', inbound: false },
};

/** Words in curly braces that the app fills in for each message. */
export const TOKENS: { token: string; means: string }[] = [
  { token: '{first_name}', means: 'Their first name, or "there" when unknown' },
  { token: '{company}', means: 'The company' },
  { token: '{role}', means: 'The job title' },
  { token: '{me}', means: 'Your first name' },
  { token: '{proof}', means: 'One sentence built from a real line on your resume that matches the posting. Empty when none matches.' },
  { token: '{days_ago}', means: 'How long ago you applied, like "7 days ago"' },
  { token: '{their_subject}', means: 'The subject of the email you are answering' },
  { token: '{interview_time}', means: 'The interview time found in their email, when there is one' },
  { token: '{time_line}', means: 'Confirms the interview time when one was found. Otherwise asks you to add your availability.' },
];

const T = (...lines: string[]) => lines.join('\n');

export const DEFAULT_REPLY_CONFIG: ReplyConfig = {
  enabled: true,
  rules: {
    outreach: { on: true, delayHours: 0, subject: '{role} application', body: T('Hi {first_name},', '', 'I just applied for the {role} role at {company}. {proof}', "If you're the right person to talk to about the role, I'd welcome a quick conversation.", '', 'Thanks,', '{me}') },
    confirmation: { on: false, delayHours: 0, subject: 'Re: {their_subject}', body: T('Hi {first_name},', '', 'Thank you for confirming my application for the {role} role. I am glad to share anything else that would help.', '', 'Thanks,', '{me}') },
    assessment: { on: true, delayHours: 0, subject: 'Re: {their_subject}', body: T('Hi {first_name},', '', 'Thank you for sending the assessment for the {role} role. I will complete it by [add the day].', '', 'Thanks,', '{me}') },
    interview: { on: true, delayHours: 0, subject: 'Re: {their_subject}', body: T('Hi {first_name},', '', 'Thank you for the invitation to talk about the {role} role at {company}. {time_line}', '', 'Thanks,', '{me}') },
    rejection: { on: false, delayHours: 0, subject: 'Re: {their_subject}', body: T('Hi {first_name},', '', 'Thank you for letting me know about the {role} role. I enjoyed learning about {company} and would be glad to be considered for future openings.', '', 'Best,', '{me}') },
    thankyou: { on: true, delayHours: 2, subject: 'Thank you: {role}', body: T('Hi {first_name},', '', 'Thank you for taking the time to talk with me about the {role} role. I enjoyed learning about the team and I am excited about the chance to contribute at {company}.', '', '[Add one specific thing you discussed.]', '', 'Thanks again,', '{me}') },
    followup: { on: true, delayHours: 0, subject: 'Following up: {role}', body: T('Hi {first_name},', '', 'I applied for the {role} role at {company} {days_ago} and wanted to follow up. I am still very interested and happy to share anything that would help.', '', 'Thanks,', '{me}') },
  },
  followup: { firstDays: 7, everyDays: 7, max: 2, weekdaysOnly: true },
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const text = (v: unknown, max: number, fallback: string) => (typeof v === 'string' && v.trim() ? v.replace(/\r\n/g, '\n').replace(/—/g, ', ').slice(0, max) : fallback);

/** The saved rules on top of the defaults. Anything missing or out of range falls back. */
export function replyConfig(prefs: any): ReplyConfig {
  const r = prefs?.responses && typeof prefs.responses === 'object' ? prefs.responses : {};
  const d = DEFAULT_REPLY_CONFIG;
  const rules = {} as Record<ReplyKind, ReplyRule>;
  for (const k of REPLY_KINDS) {
    const s = r.rules?.[k] ?? {};
    rules[k] = {
      on: typeof s.on === 'boolean' ? s.on : d.rules[k].on,
      delayHours: clampInt(s.delayHours, 0, 72, d.rules[k].delayHours),
      subject: text(s.subject, 200, d.rules[k].subject).replace(/\n/g, ' '),
      body: text(s.body, 4000, d.rules[k].body),
    };
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    rules,
    followup: {
      firstDays: clampInt(r.followup?.firstDays, 2, 30, d.followup.firstDays),
      everyDays: clampInt(r.followup?.everyDays, 2, 30, d.followup.everyDays),
      max: clampInt(r.followup?.max, 0, 5, d.followup.max),
      weekdaysOnly: typeof r.followup?.weekdaysOnly === 'boolean' ? r.followup.weekdaysOnly : d.followup.weekdaysOnly,
    },
  };
}

// ── Wording ────────────────────────────────────────────────────────────────

export function firstName(name: string | null | undefined) {
  return (name ?? '').trim().split(/\s+/)[0] || 'there';
}

export function bestContact(store: JobHuntStore, app: App) {
  return store.contacts(app.id).find((c) => c.email) ?? null;
}

/** The master-resume bullet (verbatim) that covers the most matched keywords, to ground a note. */
export function proofLine(app: App, store: JobHuntStore, master: MasterResume): string | null {
  const report: any = store.latestDocument(app.id, 'resume')?.report;
  const keywords: string[] = report?.matchedKeywords ?? [];
  if (!keywords.length) return null;
  let best: { text: string; n: number } | null = null;
  for (const w of master.work ?? []) {
    for (const h of w.highlights ?? []) {
      const n = keywords.filter((k) => matchesTerm(h, k)).length;
      if (n && (!best || n > best.n)) best = { text: h, n };
    }
  }
  return best?.text ?? null;
}

export function formatWhen(at: number) {
  return `${new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
}

export interface TemplateContext {
  contactName?: string | null;
  company: string;
  role: string;
  me: string;
  proof?: string | null;
  daysAgo?: number | null;
  theirSubject?: string | null;
  interviewAt?: number | null;
}

/** Fill a template. A token with nothing to fill becomes a [bracket] the person has to complete. */
export function renderTemplate(template: string, c: TemplateContext): string {
  const proof = c.proof ? `For example, I ${c.proof.replace(/\.$/, '').replace(/^([A-Z])(?=[a-z])/, (ch) => ch.toLowerCase())}.` : '';
  const when = c.interviewAt ? formatWhen(c.interviewAt) : null;
  const values: Record<string, string> = {
    first_name: firstName(c.contactName),
    company: c.company,
    role: c.role,
    me: c.me,
    proof,
    days_ago: c.daysAgo == null ? 'recently' : c.daysAgo <= 1 ? 'yesterday' : c.daysAgo >= 6 && c.daysAgo <= 8 ? 'last week' : `${c.daysAgo} days ago`,
    their_subject: (c.theirSubject ?? '').replace(/^(re:\s*)+/i, '') || `${c.role} at ${c.company}`,
    interview_time: when ?? '[add the time]',
    time_line: when ? `${when} works for me, and I look forward to it.` : 'I am available [add two or three times that work].',
  };
  return template
    .replace(/\{([a-z_]+)\}/g, (_m, key: string) => (key in values ? values[key] : `[${key}]`))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Bracketed notes the person still has to fill in, like "[add the day]". */
export function placeholders(body: string): string[] {
  return [...new Set(body.match(/\[[^\]\n]{3,80}\]/g) ?? [])];
}

// ── The queue ──────────────────────────────────────────────────────────────

export interface ReplyDraft {
  id: string;
  /** One draft per trigger: a second one with the same key is never made. */
  key: string;
  applicationId: string;
  kind: ReplyKind;
  to: string | null;
  toName: string | null;
  subject: string;
  body: string;
  /** Message-ID of the email this answers, so the reply threads. */
  inReplyTo: string | null;
  /** Plain words on why this was drafted. */
  reason: string;
  dueAt: number;
  createdAt: number;
  /** pending: waiting for the person. sent: they pressed Send here. gmail: moved to Gmail Drafts. done: they sent it themselves. dismissed: thrown away. */
  status: 'pending' | 'sent' | 'gmail' | 'done' | 'dismissed';
  closedAt: number | null;
  edited: boolean;
  notified: boolean;
}

export interface ThreadEmail {
  at: number;
  from: string;
  address: string | null;
  subject: string;
  snippet: string;
  category: string;
  messageId: string | null;
  /** Why no reply was drafted, when one was not. */
  note: string | null;
}

const DRAFTS_KEY = 'reply_drafts';

export function loadDrafts(store: JobHuntStore): ReplyDraft[] {
  try {
    const v = JSON.parse(store.getKv(DRAFTS_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveDrafts(store: JobHuntStore, list: ReplyDraft[]) {
  // Keep every open draft and the 300 most recent closed ones.
  const open = list.filter((d) => d.status === 'pending');
  const closed = list.filter((d) => d.status !== 'pending').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 300);
  store.setKv(DRAFTS_KEY, JSON.stringify([...open, ...closed]));
}

export function loadThread(store: JobHuntStore, applicationId: string): ThreadEmail[] {
  try {
    const v = JSON.parse(store.getKv(`thread_${applicationId}`) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface ReplyDeps {
  store: JobHuntStore;
  sms: SmsSender;
  mail: MailSource | null;
  master: () => MasterResume;
  prefs?: () => any;
  now?: () => number;
}

const clock = (deps: { now?: () => number }) => (deps.now ?? Date.now)();
const findApp = (store: JobHuntStore, id: string) => store.listApplications().find((a) => a.id === id) ?? null;

function appliedAt(store: JobHuntStore, app: App): number {
  const sent = store.history(app.id).filter((h) => h.toStatus === 'applied');
  return sent.length ? sent[sent.length - 1].createdAt : app.updatedAt;
}

async function announce(deps: ReplyDeps, app: App, draft: ReplyDraft) {
  const body = `[Job ${app.id.slice(0, 4)}] ${KIND_INFO[draft.kind].label} drafted for ${app.job.company}. Open Replies to review it. Nothing is sent until you press Send.`;
  const sent = await deps.sms.send(body, 'drafts' as NotifyCategory);
  deps.store.logNotification({ applicationId: app.id, channel: 'sms', body, ...sent });
}

export interface QueueOptions {
  key: string;
  reason: string;
  /** The email being answered. */
  inbound?: { address: string; name: string | null; subject: string; messageId: string | null };
  interviewAt?: number | null;
  /** When the trigger happened. The rule's delay is added to it. */
  from?: number;
  /** Skip the rule's on/off switch (the person asked for this draft). */
  manual?: boolean;
}

/** Write one draft into the queue if its rule is on and it was not drafted before. */
export async function queueReply(deps: ReplyDeps, app: App, kind: ReplyKind, o: QueueOptions): Promise<ReplyDraft | null> {
  const cfg = replyConfig(deps.prefs?.());
  if (!o.manual && (!cfg.enabled || !cfg.rules[kind].on)) return null;
  const drafts = loadDrafts(deps.store);
  if (drafts.some((d) => d.key === o.key)) return null;
  const now = clock(deps);
  const master = deps.master();
  const contact = o.inbound ? { name: o.inbound.name, email: o.inbound.address } : bestContact(deps.store, app);
  const rule = cfg.rules[kind];
  const context: TemplateContext = {
    contactName: contact?.name ?? null, company: app.job.company, role: app.job.title, me: master.basics.name.split(/\s+/)[0],
    proof: proofLine(app, deps.store, master), daysAgo: Math.max(0, Math.round((now - appliedAt(deps.store, app)) / DAY)),
    theirSubject: o.inbound?.subject ?? null, interviewAt: o.interviewAt ?? null,
  };
  const draft: ReplyDraft = {
    id: randomUUID(), key: o.key, applicationId: app.id, kind,
    to: contact?.email ?? null, toName: contact?.name ?? null,
    subject: renderTemplate(rule.subject, context).replace(/\s+/g, ' '), body: renderTemplate(rule.body, context),
    inReplyTo: o.inbound?.messageId ?? null, reason: o.reason,
    dueAt: (o.from ?? now) + (o.manual ? 0 : rule.delayHours * HOUR), createdAt: now,
    status: 'pending', closedAt: null, edited: false, notified: false,
  };
  if (draft.dueAt <= now) {
    draft.notified = true;
    await announce(deps, app, draft);
  }
  saveDrafts(deps.store, [...loadDrafts(deps.store), draft]);
  return draft;
}

/** Text the person about scheduled drafts that have just become ready. */
export async function announceDue(deps: ReplyDeps): Promise<string[]> {
  const now = clock(deps);
  const done: string[] = [];
  for (const d of loadDrafts(deps.store).filter((x) => x.status === 'pending' && !x.notified && x.dueAt <= now)) {
    const app = findApp(deps.store, d.applicationId);
    patch(deps.store, d.id, { notified: true });
    if (!app) continue;
    await announce(deps, app, d);
    done.push(`ready ${d.kind} ${app.id.slice(0, 8)}`);
  }
  return done;
}

function patch(store: JobHuntStore, id: string, change: Partial<ReplyDraft>): ReplyDraft {
  const list = loadDrafts(store);
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) throw new Error('That draft is gone.');
  list[i] = { ...list[i], ...change };
  saveDrafts(store, list);
  return list[i];
}

function openDraft(store: JobHuntStore, id: string): ReplyDraft {
  const d = loadDrafts(store).find((x) => x.id === id);
  if (!d) throw new Error('That draft is gone.');
  if (d.status !== 'pending') throw new Error('That draft is already closed.');
  return d;
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

/** Save the person's edits to a draft. */
export function editDraft(store: JobHuntStore, id: string, input: { to?: string; subject?: string; body?: string }): ReplyDraft {
  const d = openDraft(store, id);
  const to = typeof input.to === 'string' ? input.to.trim().slice(0, 200) : d.to ?? '';
  if (to && !EMAIL.test(to)) throw new Error('That does not look like an email address.');
  const subject = typeof input.subject === 'string' ? input.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : d.subject;
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').slice(0, 6000) : d.body;
  if (!subject) throw new Error('Add a subject.');
  if (!body.trim()) throw new Error('The message is empty.');
  return patch(store, id, { to: to || null, subject, body, edited: d.edited || subject !== d.subject || body !== d.body });
}

export function dismissDraft(store: JobHuntStore, id: string, now = Date.now()): ReplyDraft {
  openDraft(store, id);
  return patch(store, id, { status: 'dismissed', closedAt: now });
}

/** The person sent it some other way (their mail app, LinkedIn). */
export function markDraftSent(store: JobHuntStore, id: string, now = Date.now()): ReplyDraft {
  openDraft(store, id);
  return patch(store, id, { status: 'done', closedAt: now });
}

export function snoozeDraft(store: JobHuntStore, id: string, days: number, now = Date.now()): ReplyDraft {
  openDraft(store, id);
  return patch(store, id, { dueAt: now + clampInt(days, 1, 30, 1) * DAY, notified: false });
}

function ready(d: ReplyDraft): string | null {
  if (!d.to || !EMAIL.test(d.to)) return 'Add the email address to send to.';
  const open = placeholders(`${d.subject}\n${d.body}`);
  if (open.length) return `Fill in ${open.join(' and ')} first.`;
  return null;
}

/**
 * Email one draft. Only ever called from the person pressing Send on that
 * draft. Refuses when brackets are still unfilled.
 */
export async function sendDraft(deps: ReplyDeps, id: string): Promise<ReplyDraft> {
  const d = openDraft(deps.store, id);
  const problem = ready(d);
  if (problem) throw new Error(problem);
  if (!deps.mail?.send) throw new Error('Email is not connected on the computer, so this cannot be sent from here. Open it in your mail app instead.');
  const sent = await deps.mail.send({ to: d.to!, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
  if (sent.messageId) deps.store.recordSentEmail(d.applicationId, sent.messageId, d.to!);
  return patch(deps.store, id, { status: 'sent', closedAt: clock(deps) });
}

/** Put one draft in the person's Gmail Drafts folder. Does not send. */
export async function draftToGmail(deps: ReplyDeps, id: string): Promise<ReplyDraft> {
  const d = openDraft(deps.store, id);
  if (!d.to || !EMAIL.test(d.to)) throw new Error('Add the email address first.');
  if (!deps.mail?.createDraft) throw new Error('Email is not connected on the computer.');
  await deps.mail.createDraft({ to: d.to, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
  return patch(deps.store, id, { status: 'gmail', closedAt: clock(deps) });
}

// ── Triggers ───────────────────────────────────────────────────────────────

const INBOUND_KINDS: Record<string, ReplyKind | undefined> = { confirmation: 'confirmation', assessment: 'assessment', interview: 'interview', rejection: 'rejection' };

/** An employer email was matched to an application: keep it for the exchange view and draft the reply. */
export async function onInboundEmail(deps: ReplyDeps, applicationId: string, category: string, raw: string, interview: InterviewTime | null = null): Promise<ReplyDraft | null> {
  const app = findApp(deps.store, applicationId);
  if (!app) return null;
  const email = parseEmail(raw);
  const header = raw.match(/^date:\s*(.+)$/im)?.[1];
  const sentAt = header ? Date.parse(header) : NaN;
  const now = clock(deps);
  const person = senderContact(email);
  const kind = INBOUND_KINDS[category];
  const cfg = replyConfig(deps.prefs?.());
  let note: string | null = null;
  if (!kind) note = null;
  else if (!cfg.enabled || !cfg.rules[kind].on) note = 'No reply drafted: this rule is off.';
  else if (!person) note = 'No reply drafted: it came from an automated address.';
  const item: ThreadEmail = {
    at: Number.isFinite(sentAt) && sentAt <= now + HOUR ? sentAt : now,
    from: email.from.replace(/<[^>]*>/, '').replace(/["']/g, '').trim() || email.fromAddress || 'Unknown sender',
    address: email.fromAddress, subject: email.subject.slice(0, 200),
    snippet: email.text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 320),
    category, messageId: email.messageId, note,
  };
  const thread = loadThread(deps.store, app.id).filter((t) => !(t.messageId && t.messageId === item.messageId));
  deps.store.setKv(`thread_${app.id}`, JSON.stringify([...thread, item].slice(-40)));
  if (!kind || note || !person) return null;
  return queueReply(deps, app, kind, {
    key: `${kind}:${app.id}:${email.messageId ?? item.at}`,
    reason: `${item.from} sent "${item.subject.slice(0, 70)}"`,
    inbound: { address: person.email, name: person.name, subject: email.subject, messageId: email.messageId ? `<${email.messageId}>` : null },
    interviewAt: interview?.start ?? null,
  });
}

export interface FollowupPlan {
  /** When the next follow-up will be drafted, or null. */
  at: number | null;
  n: number;
  why: string;
}

const WAITING: ApplicationStatus[] = ['applied', 'acknowledged'];

function nextWeekday(at: number): number {
  const d = new Date(at);
  const day = d.getDay();
  return day === 6 ? at + 2 * DAY : day === 0 ? at + DAY : at;
}

export const pausedKey = (applicationId: string) => `replies_paused_${applicationId}`;

/** When the next follow-up for an application is due, or why there will not be one. */
export function followupPlan(store: JobHuntStore, app: App, cfg: ReplyConfig, drafts: ReplyDraft[]): FollowupPlan {
  const mine = drafts.filter((d) => d.applicationId === app.id && d.kind === 'followup');
  // An application followed up before the workshop existed counts as one.
  const used = mine.length + (!mine.length && store.getKv(`followup_${app.id}`) ? 1 : 0);
  const n = used + 1;
  if (!cfg.enabled) return { at: null, n, why: 'Reply drafting is turned off.' };
  if (!cfg.rules.followup.on || cfg.followup.max === 0) return { at: null, n, why: 'Follow-ups are turned off.' };
  if (!WAITING.includes(app.status)) {
    const moved = ['assessment', 'screening', 'interviewing', 'offer', 'accepted'].includes(app.status);
    return { at: null, n, why: moved ? 'They answered, so follow-ups stopped.' : app.status === 'saved' || app.status === 'tailored' ? 'Not sent yet.' : 'This application is closed.' };
  }
  if (store.getKv(pausedKey(app.id)) === '1') return { at: null, n, why: 'Follow-ups are paused for this application.' };
  if (mine.some((d) => d.status === 'pending')) return { at: null, n: used, why: 'A follow-up is waiting in your queue.' };
  if (used >= cfg.followup.max) return { at: null, n, why: `All ${cfg.followup.max} follow-up${cfg.followup.max === 1 ? '' : 's'} used.` };
  const last = mine.reduce((m, d) => Math.max(m, d.closedAt ?? d.createdAt), 0);
  const anchor = Math.max(app.updatedAt, last);
  const due = anchor + (used === 0 ? cfg.followup.firstDays : cfg.followup.everyDays) * DAY;
  return { at: cfg.followup.weekdaysOnly ? nextWeekday(due) : due, n, why: used === 0 ? `${cfg.followup.firstDays} days after the last activity.` : `${cfg.followup.everyDays} days after the last follow-up.` };
}

/** Draft the follow-ups that are due. Called on every scheduler tick. */
export async function runReplyFollowups(deps: ReplyDeps): Promise<string[]> {
  const now = clock(deps);
  const cfg = replyConfig(deps.prefs?.());
  const done: string[] = [];
  for (const app of deps.store.listApplications()) {
    if (!WAITING.includes(app.status)) continue;
    const plan = followupPlan(deps.store, app, cfg, loadDrafts(deps.store));
    // Skip anything that has been silent for more than 45 days: it is stale, not waiting.
    if (plan.at == null || now < plan.at || now - app.updatedAt > 45 * DAY) continue;
    const draft = await queueReply(deps, app, 'followup', { key: `followup:${app.id}:${plan.n}`, reason: `No reply for ${Math.round((now - app.updatedAt) / DAY)} days. Follow-up ${plan.n} of ${cfg.followup.max}.` });
    if (draft) done.push(`follow-up ${app.id.slice(0, 8)}`);
  }
  return done;
}

/** The person asked for a draft now, whatever the rules say. */
export async function composeNow(deps: ReplyDeps, applicationId: string, kind: ReplyKind): Promise<ReplyDraft> {
  const app = findApp(deps.store, applicationId);
  if (!app) throw new Error('That application is gone.');
  const draft = await queueReply(deps, app, kind, { key: `manual:${kind}:${app.id}:${clock(deps)}`, reason: 'You asked for this draft.', manual: true });
  if (!draft) throw new Error('Could not write that draft.');
  return draft;
}

/** What a rule would write for one application, without saving anything. */
export function previewRule(deps: ReplyDeps, cfg: ReplyConfig, kind: ReplyKind, applicationId: string | null): { subject: string; body: string; to: string; forLabel: string } {
  const app = applicationId ? findApp(deps.store, applicationId) : null;
  let me = 'You';
  let proof: string | null = null;
  try {
    const master = deps.master();
    me = master.basics.name.split(/\s+/)[0];
    if (app) proof = proofLine(app, deps.store, master);
  } catch {
    /* no resume yet */
  }
  const contact = app ? bestContact(deps.store, app) : null;
  const context: TemplateContext = {
    contactName: contact?.name ?? (app ? null : 'Jordan'), company: app?.job.company ?? 'Example Co', role: app?.job.title ?? 'QA Engineer', me, proof,
    daysAgo: app ? Math.max(0, Math.round((clock(deps) - appliedAt(deps.store, app)) / DAY)) : cfg.followup.firstDays,
    theirSubject: KIND_INFO[kind].inbound ? `${app?.job.title ?? 'QA Engineer'} at ${app?.job.company ?? 'Example Co'}` : null,
  };
  return {
    subject: renderTemplate(cfg.rules[kind].subject, context).replace(/\s+/g, ' '), body: renderTemplate(cfg.rules[kind].body, context),
    to: contact?.email ?? (app ? 'No contact email on file yet' : 'jordan@example.com'), forLabel: app ? `${app.job.company}, ${app.job.title}` : 'a sample application',
  };
}

// ── The exchange view ──────────────────────────────────────────────────────

export interface ThreadItem {
  at: number;
  /** status: the tracker moved. in: they wrote. out: you sent. draft: waiting on you. skipped: you dismissed a draft. */
  type: 'status' | 'in' | 'out' | 'draft' | 'skipped';
  title: string;
  detail: string;
}

const STATUS_WORDS: Record<string, string> = {
  saved: 'Saved', tailored: 'Resume tailored', applied: 'Application sent', acknowledged: 'They confirmed receipt', assessment: 'Assessment stage', screening: 'Screening call stage',
  interviewing: 'Interview stage', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Marked as no response', bounced: 'Email bounced',
};

/** Everything that went back and forth on one application, oldest first. */
export function exchange(store: JobHuntStore, app: App, drafts: ReplyDraft[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const h of store.history(app.id)) {
    if (h.toStatus === 'saved') continue;
    items.push({ at: h.createdAt, type: 'status', title: STATUS_WORDS[h.toStatus] ?? h.toStatus, detail: h.reason ?? '' });
  }
  for (const t of loadThread(store, app.id)) {
    items.push({ at: t.at, type: 'in', title: `${t.from}: ${t.subject}`, detail: [t.snippet, t.note].filter(Boolean).join(' ') });
  }
  for (const d of drafts.filter((x) => x.applicationId === app.id)) {
    const label = KIND_INFO[d.kind].label;
    if (d.status === 'pending') items.push({ at: d.createdAt, type: 'draft', title: `${label} drafted, waiting for you`, detail: d.reason });
    else if (d.status === 'dismissed') items.push({ at: d.closedAt ?? d.createdAt, type: 'skipped', title: `${label} dismissed`, detail: d.reason });
    else items.push({ at: d.closedAt ?? d.createdAt, type: 'out', title: `${label} ${d.status === 'gmail' ? 'moved to Gmail Drafts' : d.status === 'done' ? 'sent by you' : 'sent'}: ${d.subject}`, detail: d.body.replace(/\s+/g, ' ').slice(0, 320) });
  }
  return items.sort((a, b) => a.at - b.at);
}
