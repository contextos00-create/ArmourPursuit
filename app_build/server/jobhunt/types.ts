'use strict';

/**
 * Shared types for the job-hunt pipeline: postings, applications, the status
 * state machine, generated documents, notifications and inbound email events.
 */

export const APPLICATION_STATUSES = [
  'saved',        // posting captured, nothing generated yet
  'tailored',     // resume + cover letter generated, awaiting review
  'applied',      // user submitted the application
  'acknowledged', // employer confirmed receipt
  'assessment',   // online assessment / take-home received
  'bounced',      // an email tied to this application bounced
  'screening',    // recruiter / phone screen
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',      // no response after the follow-up window
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Allowed transitions. Anything not listed is rejected so the history stays
 * believable. `bounced` can be entered from any active state (an email tied
 * to the application failed) and left once the user resends.
 */
export const STATUS_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  saved: ['tailored', 'applied', 'bounced', 'withdrawn'],
  tailored: ['tailored', 'applied', 'bounced', 'withdrawn'],
  applied: ['acknowledged', 'assessment', 'bounced', 'screening', 'interviewing', 'rejected', 'withdrawn', 'ghosted', 'offer'],
  acknowledged: ['assessment', 'bounced', 'screening', 'interviewing', 'rejected', 'withdrawn', 'ghosted', 'offer'],
  assessment: ['assessment', 'screening', 'interviewing', 'rejected', 'withdrawn', 'ghosted', 'offer'],
  // After fixing the address and resending, move back to where things were.
  bounced: ['applied', 'acknowledged', 'screening', 'interviewing', 'withdrawn'],
  screening: ['assessment', 'bounced', 'interviewing', 'rejected', 'withdrawn', 'offer', 'ghosted'],
  interviewing: ['assessment', 'bounced', 'interviewing', 'offer', 'rejected', 'withdrawn', 'ghosted'],
  offer: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
  ghosted: ['acknowledged', 'assessment', 'screening', 'interviewing', 'rejected', 'offer'],
};

export type JobSource = 'greenhouse' | 'lever' | 'ashby' | 'adzuna' | 'manual';

export interface JobPosting {
  id: string;
  source: JobSource;
  sourceId: string | null;
  url: string | null;
  company: string;
  title: string;
  location: string | null;
  descriptionText: string;
  fitScore?: number | null;
  fitRoute?: 'auto_tailor' | 'needs_approval' | 'filtered_out' | null;
  fitDetail?: unknown;
  createdAt: number;
}

export interface NewJobPosting {
  source?: JobSource;
  sourceId?: string | null;
  url?: string | null;
  company: string;
  title: string;
  location?: string | null;
  descriptionText: string;
}

export interface Application {
  id: string;
  jobId: string;
  status: ApplicationStatus;
  /** Recruiter or application inbox address the user emailed, if any. */
  contactEmail: string | null;
  /** RFC 5322 Message-IDs of emails the user sent for this application. */
  sentMessageIds: string[];
  notes: string | null;
  appliedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface StatusEvent {
  id: number;
  applicationId: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus;
  reason: string | null;
  source: 'user' | 'email-monitor' | 'system';
  createdAt: number;
}

export type DocumentKind = 'resume' | 'cover_letter';

export interface GeneratedDocument {
  id: string;
  applicationId: string;
  kind: DocumentKind;
  markdown: string;
  html: string;
  /** JSON report: matched requirements, gaps, rejected rewrites. */
  report: TailoringReport | CoverLetterReport;
  createdAt: number;
}

export interface Requirement {
  text: string;
  kind: 'must' | 'nice';
  keywords: string[];
}

export interface TailoringReport {
  requirements: Requirement[];
  matchedKeywords: string[];
  /** Requirement keywords the master resume has no evidence for. Never filled in. */
  gaps: string[];
  /** LLM rewrites that were discarded because they added unsupported facts. */
  rejectedRewrites: { original: string; rewritten: string; reason: string }[];
  fitScore: number; // 0-100, share of requirement keywords evidenced
}

export interface CoverLetterReport {
  usedBulletIds: string[];
  rejectedSentences: { sentence: string; reason: string }[];
  generatedBy: 'llm' | 'template';
}

/** Subset of the JSON Resume schema (https://jsonresume.org/schema). */
export interface MasterResume {
  basics: {
    name: string;
    label?: string;
    email?: string;
    phone?: string;
    url?: string;
    summary?: string;
    location?: { city?: string; region?: string; countryCode?: string };
    profiles?: { network: string; url?: string; username?: string }[];
  };
  work?: {
    name: string;
    position: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    highlights?: string[];
  }[];
  projects?: { name: string; description?: string; highlights?: string[]; keywords?: string[]; url?: string }[];
  education?: { institution: string; area?: string; studyType?: string; startDate?: string; endDate?: string }[];
  skills?: { name: string; keywords?: string[] }[];
  certificates?: { name: string; issuer?: string; date?: string }[];
}

export interface NotificationRecord {
  id: number;
  applicationId: string | null;
  channel: 'sms';
  body: string;
  /** muted: turned off. app: shown in the app only. held: waiting for quiet hours to end. */
  status: 'sent' | 'dry-run' | 'failed' | 'muted' | 'app' | 'held';
  providerId: string | null;
  error: string | null;
  createdAt: number;
}

export type EmailCategory = 'confirmation' | 'assessment' | 'interview' | 'rejection' | 'verification' | 'other';

export interface EmailEvent {
  id: number;
  provider: 'gmail';
  providerMessageId: string;
  scanner: 'bounce' | 'inbox';
  kind: 'bounce' | EmailCategory;
  applicationId: string | null;
  bouncedRecipient: string | null;
  diagnostic: string | null;
  createdAt: number;
}

/** Minimal text-generation seam so tests and any provider can plug in. */
export type GenerateText = (prompt: string, options?: { system?: string; maxTokens?: number }) => Promise<string>;
