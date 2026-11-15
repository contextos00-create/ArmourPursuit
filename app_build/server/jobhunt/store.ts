'use strict';

/**
 * SQLite persistence for the job-hunt pipeline.
 *
 * Uses Node's built-in `node:sqlite` (Node 24) so this module adds no native
 * dependency. It keeps its own database file under `app_build/server/data/`
 * (gitignored local runtime state) instead of touching `contextos.db`.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  APPLICATION_STATUSES,
  STATUS_TRANSITIONS,
  type Application,
  type ApplicationStatus,
  type DocumentKind,
  type EmailEvent,
  type GeneratedDocument,
  type JobPosting,
  type NewJobPosting,
  type NotificationRecord,
  type StatusEvent,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');

export const DEFAULT_DB_PATH = process.env.JOBHUNT_DB ?? join(__dirname, '..', 'data', 'jobhunt.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jh_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT,
  url TEXT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  description_text TEXT NOT NULL,
  fit_score INTEGER,
  fit_route TEXT,
  fit_detail TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (source, source_id)
);
CREATE TABLE IF NOT EXISTS jh_applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jh_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  contact_email TEXT,
  sent_message_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jh_applications_contact ON jh_applications(contact_email);
CREATE TABLE IF NOT EXISTS jh_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES jh_applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jh_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES jh_applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  markdown TEXT NOT NULL,
  html TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jh_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jh_email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  scanner TEXT NOT NULL DEFAULT 'bounce',
  kind TEXT NOT NULL,
  application_id TEXT,
  bounced_recipient TEXT,
  diagnostic TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_message_id, scanner)
);
CREATE TABLE IF NOT EXISTS jh_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES jh_applications(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT,
  email TEXT,
  linkedin_url TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jh_contacts_email ON jh_contacts(application_id, email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS jh_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface StatusChange {
  application: Application;
  job: JobPosting;
  event: StatusEvent;
}

export class TransitionError extends Error {
  code = 'INVALID_TRANSITION';
}

function rowToJob(r: any): JobPosting {
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id ?? null,
    url: r.url ?? null,
    company: r.company,
    title: r.title,
    location: r.location ?? null,
    descriptionText: r.description_text,
    fitScore: r.fit_score == null ? null : Number(r.fit_score),
    fitRoute: r.fit_route ?? null,
    fitDetail: r.fit_detail ? JSON.parse(r.fit_detail) : null,
    createdAt: Number(r.created_at),
  };
}

function rowToApplication(r: any): Application {
  return {
    id: r.id,
    jobId: r.job_id,
    status: r.status,
    contactEmail: r.contact_email ?? null,
    sentMessageIds: JSON.parse(r.sent_message_ids || '[]'),
    notes: r.notes ?? null,
    appliedAt: r.applied_at == null ? null : Number(r.applied_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToEvent(r: any): StatusEvent {
  return {
    id: Number(r.id),
    applicationId: r.application_id,
    fromStatus: r.from_status ?? null,
    toStatus: r.to_status,
    reason: r.reason ?? null,
    source: r.source,
    createdAt: Number(r.created_at),
  };
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const match = String(email).match(/<([^>]+)>/);
  const bare = (match ? match[1] : String(email)).trim().toLowerCase();
  return bare.includes('@') ? bare : null;
}

export function normalizeMessageId(id: string): string {
  return String(id).trim().replace(/^<|>$/g, '').toLowerCase();
}

export class JobHuntStore {
  readonly db: any;
  private readonly events = new EventEmitter();
  private readonly now: () => number;

  constructor(options: { path?: string; now?: () => number } = {}) {
    const path = options.path ?? DEFAULT_DB_PATH;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
    this.db.exec(SCHEMA);
    this.now = options.now ?? Date.now;
  }

  close() {
    this.db.close();
  }

  /** Subscribe to every committed status change. Returns an unsubscribe fn. */
  onStatusChange(listener: (change: StatusChange) => void | Promise<void>): () => void {
    this.events.on('status', listener);
    return () => this.events.off('status', listener);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  upsertJob(input: NewJobPosting): JobPosting {
    const source = input.source ?? 'manual';
    const sourceId = input.sourceId ?? null;
    if (sourceId) {
      const existing = this.db
        .prepare('SELECT * FROM jh_jobs WHERE source = ? AND source_id = ?')
        .get(source, sourceId);
      if (existing) {
        this.db
          .prepare('UPDATE jh_jobs SET url = ?, company = ?, title = ?, location = ?, description_text = ? WHERE id = ?')
          .run(input.url ?? null, input.company, input.title, input.location ?? null, input.descriptionText, existing.id);
        return this.getJob(existing.id)!;
      }
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO jh_jobs (id, source, source_id, url, company, title, location, description_text, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, source, sourceId, input.url ?? null, input.company, input.title, input.location ?? null, input.descriptionText, this.now());
    return this.getJob(id)!;
  }

  setJobFit(jobId: string, fit: { score: number; route: string; detail: unknown }) {
    this.db.prepare('UPDATE jh_jobs SET fit_score = ?, fit_route = ?, fit_detail = ? WHERE id = ?')
      .run(fit.score, fit.route, JSON.stringify(fit.detail), jobId);
  }

  findJobBySource(source: string, sourceId: string): JobPosting | null {
    const r = this.db.prepare('SELECT * FROM jh_jobs WHERE source = ? AND source_id = ?').get(source, sourceId);
    return r ? rowToJob(r) : null;
  }

  allJobs(): JobPosting[] {
    return this.db.prepare('SELECT * FROM jh_jobs ORDER BY created_at DESC').all().map(rowToJob);
  }

  getJob(id: string): JobPosting | null {
    const r = this.db.prepare('SELECT * FROM jh_jobs WHERE id = ?').get(id);
    return r ? rowToJob(r) : null;
  }

  // ── Applications ──────────────────────────────────────────────────────────

  createApplication(jobId: string, options: { contactEmail?: string | null; notes?: string | null } = {}): Application {
    if (!this.getJob(jobId)) throw new Error(`Unknown job ${jobId}`);
    const id = randomUUID();
    const t = this.now();
    this.db
      .prepare(`INSERT INTO jh_applications (id, job_id, status, contact_email, notes, created_at, updated_at)
                VALUES (?, ?, 'saved', ?, ?, ?, ?)`)
      .run(id, jobId, normalizeEmail(options.contactEmail), options.notes ?? null, t, t);
    this.db
      .prepare(`INSERT INTO jh_status_events (application_id, from_status, to_status, reason, source, created_at)
                VALUES (?, NULL, 'saved', 'created', 'system', ?)`)
      .run(id, t);
    return this.getApplication(id)!;
  }

  getApplication(id: string): Application | null {
    const r = this.db.prepare('SELECT * FROM jh_applications WHERE id = ?').get(id);
    return r ? rowToApplication(r) : null;
  }

  listApplications(filter: { status?: ApplicationStatus } = {}): (Application & { job: JobPosting })[] {
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM jh_applications WHERE status = ? ORDER BY updated_at DESC').all(filter.status)
      : this.db.prepare('SELECT * FROM jh_applications ORDER BY updated_at DESC').all();
    return rows.map((r: any) => {
      const app = rowToApplication(r);
      return { ...app, job: this.getJob(app.jobId)! };
    });
  }

  setContactEmail(applicationId: string, email: string | null) {
    this.db
      .prepare('UPDATE jh_applications SET contact_email = ?, updated_at = ? WHERE id = ?')
      .run(normalizeEmail(email), this.now(), applicationId);
  }

  /** Record an email the user sent for this application, for bounce matching. */
  recordSentEmail(applicationId: string, messageId: string, to?: string) {
    const app = this.getApplication(applicationId);
    if (!app) throw new Error(`Unknown application ${applicationId}`);
    const ids = new Set(app.sentMessageIds);
    ids.add(normalizeMessageId(messageId));
    this.db
      .prepare('UPDATE jh_applications SET sent_message_ids = ?, contact_email = COALESCE(?, contact_email), updated_at = ? WHERE id = ?')
      .run(JSON.stringify([...ids]), normalizeEmail(to), this.now(), applicationId);
  }

  findApplicationsByEmail(email: string): Application[] {
    const normalized = normalizeEmail(email);
    if (!normalized) return [];
    return this.db
      .prepare('SELECT * FROM jh_applications WHERE contact_email = ? ORDER BY updated_at DESC')
      .all(normalized)
      .map(rowToApplication);
  }

  findApplicationByMessageId(messageId: string): Application | null {
    const needle = normalizeMessageId(messageId);
    // sent_message_ids is a small JSON array; json_each keeps it exact-match.
    const r = this.db
      .prepare(`SELECT a.* FROM jh_applications a, json_each(a.sent_message_ids) m WHERE m.value = ? LIMIT 1`)
      .get(needle);
    return r ? rowToApplication(r) : null;
  }

  /**
   * Move an application to a new status. Validates the transition, writes the
   * history row, then notifies listeners (SMS etc.) after commit. Listener
   * failures never roll back the status change.
   */
  async setStatus(
    applicationId: string,
    toStatus: ApplicationStatus,
    options: { reason?: string | null; source?: StatusEvent['source']; force?: boolean } = {},
  ): Promise<StatusChange> {
    if (!APPLICATION_STATUSES.includes(toStatus)) throw new TransitionError(`Unknown status "${toStatus}"`);
    const app = this.getApplication(applicationId);
    if (!app) throw new Error(`Unknown application ${applicationId}`);
    const allowed = STATUS_TRANSITIONS[app.status];
    if (!options.force && !allowed.includes(toStatus)) {
      throw new TransitionError(`Cannot move from "${app.status}" to "${toStatus}". Allowed: ${allowed.join(', ') || 'none'}`);
    }
    const t = this.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`UPDATE jh_applications SET status = ?, updated_at = ?, applied_at = CASE WHEN ? = 'applied' THEN COALESCE(applied_at, ?) ELSE applied_at END WHERE id = ?`)
        .run(toStatus, t, toStatus, t, applicationId);
      this.db
        .prepare(`INSERT INTO jh_status_events (application_id, from_status, to_status, reason, source, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(applicationId, app.status, toStatus, options.reason ?? null, options.source ?? 'user', t);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const eventRow = this.db
      .prepare('SELECT * FROM jh_status_events WHERE application_id = ? ORDER BY id DESC LIMIT 1')
      .get(applicationId);
    const change: StatusChange = {
      application: this.getApplication(applicationId)!,
      job: this.getJob(app.jobId)!,
      event: rowToEvent(eventRow),
    };
    for (const listener of this.events.listeners('status')) {
      try {
        await (listener as any)(change);
      } catch (error) {
        console.error('[jobhunt] status listener failed:', (error as Error).message);
      }
    }
    return change;
  }

  history(applicationId: string): StatusEvent[] {
    return this.db
      .prepare('SELECT * FROM jh_status_events WHERE application_id = ? ORDER BY id ASC')
      .all(applicationId)
      .map(rowToEvent);
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  saveDocument(applicationId: string, kind: DocumentKind, doc: { markdown: string; html: string; report: any }): GeneratedDocument {
    const id = randomUUID();
    const t = this.now();
    this.db
      .prepare(`INSERT INTO jh_documents (id, application_id, kind, markdown, html, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, applicationId, kind, doc.markdown, doc.html, JSON.stringify(doc.report), t);
    return { id, applicationId, kind, markdown: doc.markdown, html: doc.html, report: doc.report, createdAt: t };
  }

  latestDocument(applicationId: string, kind: DocumentKind): GeneratedDocument | null {
    const r = this.db
      .prepare('SELECT * FROM jh_documents WHERE application_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(applicationId, kind);
    if (!r) return null;
    return { id: r.id, applicationId: r.application_id, kind: r.kind, markdown: r.markdown, html: r.html, report: JSON.parse(r.report), createdAt: Number(r.created_at) };
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  logNotification(n: Omit<NotificationRecord, 'id' | 'createdAt'>): void {
    this.db
      .prepare(`INSERT INTO jh_notifications (application_id, channel, body, status, provider_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(n.applicationId, n.channel, n.body, n.status, n.providerId, n.error, this.now());
  }

  /** Newest first, leaving out anything the person turned off. */
  recentNotifications(limit = 40): NotificationRecord[] {
    const rows = this.db.prepare("SELECT * FROM jh_notifications WHERE status != 'muted' ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(200, limit)));
    return rows.map((r: any) => ({
      id: Number(r.id), applicationId: r.application_id ?? null, channel: r.channel, body: r.body,
      status: r.status, providerId: r.provider_id ?? null, error: r.error ?? null, createdAt: Number(r.created_at),
    }));
  }

  notifications(applicationId?: string): NotificationRecord[] {
    const rows = applicationId
      ? this.db.prepare('SELECT * FROM jh_notifications WHERE application_id = ? ORDER BY id ASC').all(applicationId)
      : this.db.prepare('SELECT * FROM jh_notifications ORDER BY id ASC').all();
    return rows.map((r: any) => ({
      id: Number(r.id), applicationId: r.application_id ?? null, channel: r.channel, body: r.body,
      status: r.status, providerId: r.provider_id ?? null, error: r.error ?? null, createdAt: Number(r.created_at),
    }));
  }

  // ── Email events ──────────────────────────────────────────────────────────

  hasEmailEvent(provider: EmailEvent['provider'], providerMessageId: string, scanner: EmailEvent['scanner'] = 'bounce'): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM jh_email_events WHERE provider = ? AND provider_message_id = ? AND scanner = ?')
      .get(provider, providerMessageId, scanner);
  }

  recordEmailEvent(e: Omit<EmailEvent, 'id' | 'createdAt' | 'scanner'> & { scanner?: EmailEvent['scanner'] }): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO jh_email_events (provider, provider_message_id, scanner, kind, application_id, bounced_recipient, diagnostic, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.provider, e.providerMessageId, e.scanner ?? 'bounce', e.kind, e.applicationId, e.bouncedRecipient, e.diagnostic, this.now());
  }

  emailEvents(): EmailEvent[] {
    return this.db.prepare('SELECT * FROM jh_email_events ORDER BY id ASC').all().map((r: any) => ({
      id: Number(r.id), provider: r.provider, providerMessageId: r.provider_message_id, scanner: r.scanner, kind: r.kind,
      applicationId: r.application_id ?? null, bouncedRecipient: r.bounced_recipient ?? null,
      diagnostic: r.diagnostic ?? null, createdAt: Number(r.created_at),
    }));
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  /** Add or update a contact. Same email on the same application updates in place. */
  upsertContact(c: { applicationId: string; name?: string | null; title?: string | null; email?: string | null; linkedinUrl?: string | null; source: 'email' | 'manual' | 'referral' }) {
    const email = normalizeEmail(c.email ?? null);
    const existing = email
      ? this.db.prepare('SELECT * FROM jh_contacts WHERE application_id = ? AND email = ?').get(c.applicationId, email)
      : c.name
        ? this.db.prepare('SELECT * FROM jh_contacts WHERE application_id = ? AND email IS NULL AND lower(name) = lower(?)').get(c.applicationId, c.name)
        : null;
    if (existing) {
      this.db.prepare('UPDATE jh_contacts SET name = COALESCE(?, name), title = COALESCE(?, title), linkedin_url = COALESCE(?, linkedin_url) WHERE id = ?')
        .run(c.name ?? null, c.title ?? null, c.linkedinUrl ?? null, existing.id);
      return;
    }
    this.db.prepare('INSERT INTO jh_contacts (application_id, name, title, email, linkedin_url, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.applicationId, c.name ?? null, c.title ?? null, email, c.linkedinUrl ?? null, c.source, this.now());
  }

  contacts(applicationId: string): { name: string | null; title: string | null; email: string | null; linkedinUrl: string | null; source: string }[] {
    return this.db.prepare('SELECT * FROM jh_contacts WHERE application_id = ? ORDER BY id ASC').all(applicationId)
      .map((r: any) => ({ name: r.name ?? null, title: r.title ?? null, email: r.email ?? null, linkedinUrl: r.linkedin_url ?? null, source: r.source }));
  }

  // ── KV (monitor cursors) ──────────────────────────────────────────────────

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM jh_kv WHERE key = ?').get(key);
    return r ? r.value : null;
  }

  setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO jh_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
