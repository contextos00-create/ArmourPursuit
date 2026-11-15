'use strict';

/**
 * Read-only Gmail access over the Gmail REST API with an OAuth refresh token.
 * No SDK dependency.
 *
 * Env (gitignored app_build/server/.env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET   OAuth client (Desktop app type) from Google Cloud console
 *   GMAIL_REFRESH_TOKEN                    refresh token granted the gmail.readonly scope
 *                                          (add gmail.compose for drafts and calendar.events for
 *                                          interview events; without them those features fall back
 *                                          to files and texts)
 *   GMAIL_ADDRESS                          your address, so it is never mistaken for a bounced recipient
 */

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  address: string | null;
}

export interface MailSource {
  /** Message ids matching a Gmail search query, newest first. */
  search(query: string, max?: number): Promise<string[]>;
  /** Full RFC 5322 source of one message. */
  getRaw(id: string): Promise<string>;
  ownAddresses(): string[];
  /** Save a draft in the mailbox (needs gmail.compose). Never sends. */
  createDraft?(draft: { to: string; subject: string; body: string; inReplyTo?: string | null }): Promise<string>;
  /**
   * Send one email (needs gmail.compose or gmail.send). Only ever called when the
   * person presses Send on a draft they have read.
   */
  send?(mail: { to: string; subject: string; body: string; inReplyTo?: string | null }): Promise<{ id: string; messageId: string | null }>;
  /** Google Calendar access with the same token (needs calendar.events). */
  calendar?: {
    findEvents(timeMin: string, timeMax: string): Promise<{ id: string; summary: string; start: string }[]>;
    createEvent(e: { summary: string; start: string; end: string; location?: string | null; description?: string | null }): Promise<string>;
  };
}

export function gmailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GmailConfig | null {
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = env.GMAIL_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, address: env.GMAIL_ADDRESS?.trim().toLowerCase() || null };
}

/** One plain-text message as base64url RFC 5322. Line breaks are stripped from headers so nothing can be injected. */
export function rawMessage(d: { to: string; subject: string; body: string; inReplyTo?: string | null }): string {
  const clean = (v: string) => String(v).replace(/[\r\n]+/g, ' ').trim();
  const subject = clean(d.subject);
  const headers = [
    `To: ${clean(d.to)}`,
    `Subject: ${/^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`}`,
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'MIME-Version: 1.0',
  ];
  if (d.inReplyTo) headers.push(`In-Reply-To: ${clean(d.inReplyTo)}`, `References: ${clean(d.inReplyTo)}`);
  const body = Buffer.from(d.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

export function createGmailSource(config: GmailConfig, fetchImpl: typeof fetch = fetch): MailSource {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Gmail token refresh failed (${res.status}): ${json.error_description ?? json.error ?? 'unknown'}`);
    token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function call(url: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    const res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google API ${res.status}: ${json.error?.message ?? 'request failed'}`);
    return json;
  }
  const api = (path: string, init?: { method?: string; body?: unknown }) => call(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, init);
  const cal = (path: string, init?: { method?: string; body?: unknown }) => call(`https://www.googleapis.com/calendar/v3/calendars/primary/${path}`, init);

  return {
    async search(query: string, max = 50) {
      const json = await api(`messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
      return (json.messages ?? []).map((m: any) => m.id);
    },
    async getRaw(id: string) {
      const json = await api(`messages/${encodeURIComponent(id)}?format=raw`);
      return Buffer.from(String(json.raw ?? ''), 'base64url').toString('utf8');
    },
    ownAddresses() {
      return config.address ? [config.address] : [];
    },
    async createDraft(d) {
      const json = await api('drafts', { method: 'POST', body: { message: { raw: rawMessage(d) } } });
      return String(json.id ?? '');
    },
    async send(d) {
      const json = await api('messages/send', { method: 'POST', body: { raw: rawMessage(d) } });
      const id = String(json.id ?? '');
      let messageId: string | null = null;
      try {
        const meta = await api(`messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID`);
        const header = (meta.payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === 'message-id');
        messageId = header ? String(header.value) : null;
      } catch {
        messageId = null; // the mail went out; only reply threading by id is lost
      }
      return { id, messageId };
    },
    calendar: {
      async findEvents(timeMin, timeMax) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '20' });
        const json = await cal(`events?${q}`);
        return (json.items ?? []).map((e: any) => ({ id: e.id, summary: e.summary ?? '', start: e.start?.dateTime ?? e.start?.date ?? '' }));
      },
      async createEvent(e) {
        const json = await cal('events', {
          method: 'POST',
          body: {
            summary: e.summary, location: e.location ?? undefined, description: e.description ?? undefined,
            start: { dateTime: e.start }, end: { dateTime: e.end },
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
          },
        });
        return String(json.id ?? '');
      },
    },
  };
}

export const BOUNCE_QUERY =
  '(from:mailer-daemon OR from:postmaster OR subject:"undeliverable" OR subject:"delivery status notification" OR subject:"failure notice" OR subject:"returned mail") newer_than:14d';
