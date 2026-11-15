'use strict';

/**
 * Inbox sync: classify employer email (confirmation, assessment, interview,
 * rejection), match it to an application, and move the status. Every status
 * change texts the user through the SMS notifier. Rule-based so it is cheap,
 * explainable, and never sends email content to a third party.
 */

import { detectBounce, parseMime, type MimePart } from './bounce';
import type { MailSource } from './gmail';
import type { JobHuntStore } from './store';
import type { SmsSender } from './sms';
import { containsTerm, htmlToText, normalizeTerm } from './text';
import { STATUS_TRANSITIONS, type Application, type ApplicationStatus, type EmailCategory } from './types';

export interface ParsedEmail {
  from: string;
  fromAddress: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string[];
}

export interface Classification {
  category: EmailCategory;
  confidence: number;
  link: string | null;
  signals: string[];
}

/** Decode RFC 2047 encoded-words (=?UTF-8?B?...?= / =?UTF-8?Q?...?=). */
export function decodeHeader(value: string): string {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, _charset, enc: string, data: string) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    } catch {
      return data;
    }
  }).replace(/\?=\s+=\?/g, '');
}

function findText(part: MimePart): { plain: string; html: string } {
  let plain = '';
  let html = '';
  const visit = (p: MimePart) => {
    const ct = (p.headers['content-type'] ?? 'text/plain').toLowerCase();
    if (p.parts.length) p.parts.forEach(visit);
    else if (ct.startsWith('text/plain') && !plain) plain = p.body;
    else if (ct.startsWith('text/html') && !html) html = p.body;
  };
  visit(part);
  return { plain, html };
}

export function parseEmail(raw: string): ParsedEmail {
  const root = parseMime(raw);
  const { plain, html } = findText(root);
  const from = decodeHeader(root.headers['from'] ?? '');
  const addr = from.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return {
    from,
    fromAddress: addr ? addr[0].toLowerCase() : null,
    subject: decodeHeader(root.headers['subject'] ?? ''),
    // Keep raw HTML for link extraction; text for classification.
    text: (plain || htmlToText(html)).slice(0, 20_000) + (html ? `\n${(html.match(/https?:\/\/[^\s"'<>]+/g) || []).join('\n')}` : ''),
    messageId: (root.headers['message-id'] ?? '').replace(/[<>\s]/g, '').toLowerCase() || null,
    inReplyTo: [root.headers['in-reply-to'], root.headers['references']].join(' ').match(/<[^<>\s]+>/g)?.map((m) => m.slice(1, -1).toLowerCase()) ?? [],
  };
}

const RULES: { category: EmailCategory; weight: number; re: RegExp; label: string }[] = [
  // Rejection wording is checked first and outweighs "thank you for applying".
  { category: 'rejection', weight: 3, re: /\b(not (be )?(moving|move) forward|decided (to|not to) (move forward|proceed|pursue)|(pursue|move forward with) other candidates|other candidates (whose|who)|no longer (being )?considered|position has been filled|will not be (moving|proceeding)|unable to offer you|not selected)\b/i, label: 'rejection wording' },
  { category: 'rejection', weight: 1, re: /\bunfortunately\b/i, label: '"unfortunately"' },
  { category: 'assessment', weight: 3, re: /\b(hackerrank|codesignal|codility|testgorilla|coderbyte|hirevue|karat|qualified\.io|testdome|criteria corp)\b/i, label: 'assessment platform' },
  { category: 'assessment', weight: 2, re: /\b(online assessment|coding (challenge|assessment|test|exercise)|take[- ]home|technical assessment|skills assessment)\b/i, label: 'assessment wording' },
  { category: 'interview', weight: 3, re: /\b(calendly\.com|goodtime\.io|cal\.com|meetings\.hubspot|calendar\.app\.google|schedule (a|an|your|the) (call|chat|interview|time|phone screen)|phone screen|interview (invitation|request)|invite you to (an )?interview|next steps? (is|would be) (a|an) (call|interview))\b/i, label: 'scheduling' },
  { category: 'interview', weight: 1, re: /\b(your availability|available (for|to) (a )?(call|chat)|would love to (chat|connect|speak))\b/i, label: 'availability ask' },
  { category: 'confirmation', weight: 2, re: /\b(thank(s| you) for (applying|your application|submitting)|(we('| ha)ve|we have) received your application|application (has been )?(received|submitted)|successfully (applied|submitted))\b/i, label: 'receipt wording' },
  { category: 'verification', weight: 3, re: /\b(verification code|verify your (email|account)|one[- ]time (passcode|code)|confirm your email)\b/i, label: 'verification' },
];

const LINK_HOSTS = /(hackerrank|codesignal|codility|testgorilla|coderbyte|hirevue|karat|calendly|goodtime|cal\.com|hubspot|calendar\.app\.google)/i;

export function classifyEmail(email: Pick<ParsedEmail, 'subject' | 'text'>): Classification {
  const hay = `${email.subject}\n${email.text}`;
  const scores = new Map<EmailCategory, number>();
  const signals: string[] = [];
  for (const r of RULES) {
    if (r.re.test(hay)) {
      scores.set(r.category, (scores.get(r.category) ?? 0) + r.weight);
      signals.push(`${r.category}: ${r.label}`);
    }
  }
  // Precedence on ties: rejection > interview > assessment > confirmation.
  const order: EmailCategory[] = ['rejection', 'interview', 'assessment', 'verification', 'confirmation'];
  let best: EmailCategory = 'other';
  let bestScore = 0;
  for (const c of order) {
    const s = scores.get(c) ?? 0;
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  // "Unfortunately" alone is not enough to call a rejection.
  if (best === 'rejection' && bestScore < 2) best = 'other';
  const link = (hay.match(/https?:\/\/[^\s"'<>)\]]+/g) || []).find((u) => LINK_HOSTS.test(u)) ?? null;
  return { category: best, confidence: Math.min(1, bestScore / 4), link, signals };
}

function companyTokens(company: string): string[] {
  const n = normalizeTerm(company).replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs|group)\b/g, '').trim();
  return [n, n.replace(/\s+/g, '')].filter((t) => t.length >= 3);
}

/** Best application for an email, or null when nothing is a confident match. */
export function matchApplication(store: JobHuntStore, email: ParsedEmail): Application | null {
  for (const id of email.inReplyTo) {
    const app = store.findApplicationByMessageId(id);
    if (app) return app;
  }
  const candidates = store.listApplications().filter((a) => !['saved', 'withdrawn', 'accepted'].includes(a.status));
  const domain = email.fromAddress?.split('@')[1] ?? '';
  const scored = candidates.map((a) => {
    let score = 0;
    if (a.contactEmail && a.contactEmail === email.fromAddress) score += 5;
    const tokens = companyTokens(a.job.company);
    if (tokens.some((t) => domain.replace(/[.-]/g, '').includes(t.replace(/\s+/g, '')))) score += 3;
    if (tokens.some((t) => containsTerm(email.from, t))) score += 2;
    if (tokens.some((t) => containsTerm(email.subject, t))) score += 2;
    else if (tokens.some((t) => containsTerm(email.text.slice(0, 3000), t))) score += 1;
    if (containsTerm(`${email.subject}\n${email.text.slice(0, 3000)}`, a.job.title)) score += 2;
    return { a, score };
  }).filter((x) => x.score >= 2).sort((x, y) => y.score - x.score || y.a.updatedAt - x.a.updatedAt);
  if (!scored.length) return null;
  // Two equally good matches (same company, two roles, no title): ambiguous.
  if (scored[1] && scored[1].score === scored[0].score) return null;
  return scored[0].a;
}

function targetStatus(category: EmailCategory, current: ApplicationStatus): ApplicationStatus | null {
  switch (category) {
    case 'confirmation': return current === 'applied' ? 'acknowledged' : null;
    case 'assessment': return 'assessment';
    case 'interview': return ['screening', 'interviewing'].includes(current) ? 'interviewing' : 'screening';
    case 'rejection': return 'rejected';
    default: return null;
  }
}

/** A real person who emailed about the application (not a no-reply or ATS robot). */
export function senderContact(email: ParsedEmail): { name: string | null; email: string; title: string | null } | null {
  const addr = email.fromAddress;
  if (!addr || /^(no-?reply|donotreply|do-not-reply|notifications?|jobs|careers|recruiting|talent|hr|hiring|applications?|team)@/i.test(addr)) return null;
  if (/(greenhouse|lever|ashbyhq|workday|myworkday|icims|smartrecruiters|jobvite|bamboohr)\./i.test(addr)) return null;
  const display = email.from.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  const name = display && !display.includes('@') ? display : null;
  // Signature title: a line right after the sender's name, e.g. "Jane Doe\nTechnical Recruiter".
  let title: string | null = null;
  if (name) {
    const lines = email.text.split('\n').map((l) => l.trim());
    const i = lines.findIndex((l) => l === name || l === name.split(' ')[0]);
    const next = i >= 0 ? lines[i + 1] : '';
    if (next && next.length < 60 && /(recruit|talent|hiring|manager|director|lead|engineer|partner|coordinator|sourcer|people)/i.test(next)) title = next;
  }
  return { name, email: addr, title };
}

export interface InboxScanResult {
  scanned: number;
  updated: { applicationId: string; category: EmailCategory; to: ApplicationStatus }[];
  unmatched: { category: EmailCategory; from: string; subject: string }[];
  errors: string[];
}

export const INBOX_QUERY = 'in:inbox newer_than:3d -from:me -from:mailer-daemon -from:postmaster';

export async function scanInbox(
  store: JobHuntStore,
  mail: MailSource,
  sms: SmsSender,
  options: { query?: string; max?: number; onMatched?: (applicationId: string, category: EmailCategory, raw: string) => Promise<void> } = {},
): Promise<InboxScanResult> {
  const result: InboxScanResult = { scanned: 0, updated: [], unmatched: [], errors: [] };
  const ids = await mail.search(options.query ?? INBOX_QUERY, options.max ?? 100);
  for (const id of ids) {
    if (store.hasEmailEvent('gmail', id, 'inbox')) continue;
    result.scanned++;
    let raw: string;
    try {
      raw = await mail.getRaw(id);
    } catch (error) {
      result.errors.push(`${id}: ${(error as Error).message}`);
      continue;
    }
    const record = (kind: EmailCategory, applicationId: string | null, diagnostic: string | null) =>
      store.recordEmailEvent({ provider: 'gmail', providerMessageId: id, scanner: 'inbox', kind, applicationId, bouncedRecipient: null, diagnostic });
    if (detectBounce(raw, mail.ownAddresses()).isBounce) {
      record('other', null, 'bounce, handled by bounce monitor');
      continue;
    }
    const email = parseEmail(raw);
    const c = classifyEmail(email);
    if (c.category === 'other' || c.category === 'verification') {
      record(c.category, null, null);
      continue;
    }
    const app = matchApplication(store, email);
    if (!app) {
      record(c.category, null, `unmatched: ${email.subject.slice(0, 120)}`);
      result.unmatched.push({ category: c.category, from: email.from, subject: email.subject });
      // Interviews and assessments are time-sensitive: text even when unmatched.
      if (c.category === 'interview' || c.category === 'assessment') {
        const body = `[Job] Possible ${c.category} email from ${email.from.slice(0, 60)}: "${email.subject.slice(0, 80)}". Not linked to an application.${c.link ? ` ${c.link}` : ''}`;
        const sent = await sms.send(body, 'email');
        store.logNotification({ applicationId: null, channel: 'sms', body, ...sent });
      }
      continue;
    }
    const to = targetStatus(c.category, app.status);
    record(c.category, app.id, c.signals.join('; '));
    const contact = senderContact(email);
    if (contact) store.upsertContact({ applicationId: app.id, ...contact, source: 'email' });
    if (options.onMatched) {
      try {
        await options.onMatched(app.id, c.category, raw);
      } catch (error) {
        result.errors.push(`${id} follow-up: ${(error as Error).message}`);
      }
    }
    if (to && STATUS_TRANSITIONS[app.status].includes(to)) {
      const reason = [`email: ${email.subject.slice(0, 80)}`, c.link].filter(Boolean).join(' ');
      await store.setStatus(app.id, to, { source: 'email-monitor', reason });
      result.updated.push({ applicationId: app.id, category: c.category, to });
    }
  }
  store.setKv('inbox_last_run', String(Date.now()));
  return result;
}
