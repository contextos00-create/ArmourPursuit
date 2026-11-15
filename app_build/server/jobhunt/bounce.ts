'use strict';

/**
 * Bounce detection from raw RFC 5322 messages.
 *
 * Handles standard delivery status notifications (RFC 3464,
 * multipart/report; report-type=delivery-status), which Gmail, Outlook,
 * Postfix, Exchange and most providers send, plus a text fallback for
 * mailer-daemon messages that are not well-formed DSNs. Only permanent
 * failures count; "delayed" notices are ignored.
 */

export interface MimePart {
  headers: Record<string, string>;
  body: string;
  parts: MimePart[];
}

export interface BounceInfo {
  isBounce: boolean;
  permanent: boolean;
  recipients: string[];
  status: string | null;
  diagnostic: string | null;
  /** Message-ID(s) of the original message that bounced, normalized. */
  originalMessageIds: string[];
  subject: string | null;
}

function unfold(headerBlock: string): string[] {
  return headerBlock.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n').filter(Boolean);
}

export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of unfold(block)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(text[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBody(body: string, encoding = ''): string {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function param(headerValue: string | undefined, name: string): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? (m[2] ?? m[1]) : null;
}

export function parseMime(raw: string): MimePart {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const headerBlock = split === -1 ? text : text.slice(0, split);
  const rawBody = split === -1 ? '' : text.slice(split + 2);
  const headers = parseHeaders(headerBlock);
  const contentType = headers['content-type'] ?? 'text/plain';
  const boundary = param(contentType, 'boundary');
  if (/^multipart\//i.test(contentType) && boundary) {
    const sections = rawBody.split(new RegExp(`\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\n?`));
    const parts = sections
      .slice(1)
      .filter((s) => s.trim() && !/^--/.test(s))
      .map((s) => parseMime(s.startsWith('\n') ? s : s));
    return { headers, body: '', parts };
  }
  return { headers, body: decodeBody(rawBody, headers['content-transfer-encoding']), parts: [] };
}

function walk(part: MimePart, visit: (p: MimePart) => void) {
  visit(part);
  for (const p of part.parts) walk(p, visit);
}

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function extractMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(/<[^<>\s]+>/g) || []).map((id) => id.slice(1, -1).toLowerCase());
}

/** Parse the per-recipient fields of a message/delivery-status body. */
function parseDeliveryStatus(body: string) {
  const groups = body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map(parseHeaders);
  const out: { recipient: string | null; action: string | null; status: string | null; diagnostic: string | null }[] = [];
  for (const g of groups) {
    const rcpt = g['final-recipient'] || g['original-recipient'];
    if (!rcpt) continue;
    const addr = rcpt.replace(/^[^;]*;\s*/, '').trim().toLowerCase();
    out.push({ recipient: addr || null, action: g['action']?.toLowerCase() ?? null, status: g['status'] ?? null, diagnostic: g['diagnostic-code']?.replace(/^[^;]*;\s*/, '') ?? null });
  }
  return out;
}

export function detectBounce(raw: string, ownAddresses: string[] = []): BounceInfo {
  const root = parseMime(raw);
  const from = (root.headers['from'] ?? '').toLowerCase();
  const subject = root.headers['subject'] ?? null;
  const contentType = root.headers['content-type'] ?? '';
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const info: BounceInfo = { isBounce: false, permanent: false, recipients: [], status: null, diagnostic: null, originalMessageIds: [], subject };

  const ids = new Set<string>([...extractMessageIds(root.headers['in-reply-to']), ...extractMessageIds(root.headers['references'])]);
  let dsnFound = false;
  let textBodies = '';

  walk(root, (p) => {
    const ct = (p.headers['content-type'] ?? '').toLowerCase();
    if (ct.startsWith('message/delivery-status')) {
      dsnFound = true;
      // The DSN fields may be in the decoded body, or (for some parsers) the
      // first header-looking block of the part itself.
      for (const r of parseDeliveryStatus(p.body)) {
        if (r.action && !/fail/.test(r.action)) continue;
        if (r.status && !/^5\./.test(r.status) && r.action !== 'failed') continue;
        if (r.recipient) info.recipients.push(r.recipient);
        info.status = info.status ?? r.status;
        info.diagnostic = info.diagnostic ?? r.diagnostic;
        info.permanent = true;
      }
    } else if (ct.startsWith('message/rfc822') || ct.startsWith('text/rfc822-headers')) {
      // Embedded original: either a nested parsed message or a header block.
      const nested = p.parts[0]?.headers ?? parseHeaders(p.body.split(/\n\s*\n/)[0] ?? '');
      for (const id of extractMessageIds(nested['message-id'])) ids.add(id);
    } else if (!ct || ct.startsWith('text/plain')) {
      textBodies += `\n${p.body}`;
    }
  });

  const fromDaemon = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from);
  const isReport = /multipart\/report/i.test(contentType) && /delivery-status/i.test(contentType);

  if (!dsnFound && fromDaemon) {
    // Non-standard bounce: look for permanent-failure wording and addresses.
    const permanentCue = /(permanent(ly)? (fail|error)|could not be delivered|undeliverable|address (not found|rejected)|user unknown|no such user|does not exist|mailbox unavailable|5\.\d\.\d)/i;
    if (permanentCue.test(textBodies) || /undeliverable|failure notice|delivery status notification \(failure\)/i.test(subject ?? '')) {
      info.permanent = true;
      const statusMatch = textBodies.match(/\b5\.\d\.\d{1,3}\b/);
      info.status = statusMatch ? statusMatch[0] : null;
      const diagMatch = textBodies.match(/^.*(550|551|552|553|554|5\.\d\.\d).*$/m);
      info.diagnostic = diagMatch ? diagMatch[0].trim().slice(0, 300) : null;
      for (const addr of textBodies.match(EMAIL_RE) || []) {
        const a = addr.toLowerCase();
        if (!own.has(a) && !/mailer-daemon|postmaster|noreply|no-reply/.test(a)) info.recipients.push(a);
      }
      const embeddedIds = textBodies.match(/^message-id:\s*(<[^>]+>)/gim) || [];
      for (const line of embeddedIds) for (const id of extractMessageIds(line)) ids.add(id);
    }
  }

  info.recipients = [...new Set(info.recipients)].filter((r) => !own.has(r));
  info.originalMessageIds = [...ids];
  info.isBounce = info.permanent && (dsnFound || isReport || fromDaemon) && (info.recipients.length > 0 || info.originalMessageIds.length > 0);
  return info;
}
