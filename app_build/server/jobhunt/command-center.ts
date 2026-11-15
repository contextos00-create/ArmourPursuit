'use strict';

/**
 * Route-free service behind the /command-center page. The TanStack Start
 * server loads this in-process (serverRequire) and calls these functions
 * from typed createServerFn boundaries. One pipeline instance per process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import * as agent from './agent';
import { getPending, loadBank, saveAnswer } from './apply';
import * as session from './apply-session';
import * as remote from './remote';
import { mergeSettings, toSettings, type Settings } from './settings';
import { APPLICATION_STATUSES, STATUS_TRANSITIONS, type ApplicationStatus, type MasterResume } from './types';
import { dashboardData, dashboardMetrics, dashboardRows, linkedinSearch, type DashboardData, type DashboardMetrics } from './dashboard';
import { CATEGORY_LABEL, NOTIFY_CATEGORIES, notifySettings } from './notify';
import { buildPrepPack } from './prep';
import * as replies from './responses';
import * as workshop from './resume-workshop';
import * as planner from './plan';
import * as brain from './brain';
import type { GenerateText } from './types';
import { companyKey, loadConnections, matchReferrals, parseConnections, referralAsk } from './referrals';
import { documentDirName } from './text';
import { createJobHunt, DATA_DIR, type JobHunt } from './index';

export const AGENT_CONFIG_PATH = process.env.JOBHUNT_AGENT_CONFIG ?? join(DATA_DIR, 'agent.json');
export const REMOTE_PATH = process.env.JOBHUNT_REMOTE_CONFIG ?? join(DATA_DIR, 'remote.json');

let instance: JobHunt | null = null;

/** Lazily create the pipeline. Tests can inject one. */
export function pipeline(inject?: JobHunt): JobHunt {
  if (inject) instance = inject;
  if (!instance) instance = createJobHunt();
  return instance;
}

export interface ApplicationRow {
  id: string;
  code: string;
  company: string;
  title: string;
  location: string;
  status: ApplicationStatus;
  fit: number | null;
  url: string;
  canApply: boolean;
  needsApproval: boolean;
  nextStatuses: ApplicationStatus[];
  pending: string[];
  updatedAt: number;
}

/** Interview prep for one application, built from the posting and the resume only. */
export interface PrepRow {
  id: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  /** True once the application has reached a screen or interview. */
  live: boolean;
  covered: { requirement: string; proof: { text: string; where: string }[] }[];
  uncovered: string[];
  technical: string[];
  behavioral: string[];
  askThem: string[];
  /** The person's own notes, keyed by card ("c0" is the first proof card, "general" the free notes). */
  notes: Record<string, string>;
  /** Questions ticked off as practiced. */
  practiced: string[];
}

export interface NetworkPerson {
  name: string;
  position: string;
  url: string;
  /** A short referral ask to edit and send by hand. */
  ask: string;
}

export interface NetworkRow {
  id: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  people: NetworkPerson[];
  managerSearch: string;
  recruiterSearch: string;
}

export interface NetworkState {
  /** People in the imported LinkedIn connections file. */
  connections: number;
  atTracked: number;
  companiesWithPeople: number;
  inQa: number;
  topCompanies: { company: string; n: number }[];
  rows: NetworkRow[];
}

/** The resume as the setup form edits it. Free text only; nothing is generated. */
export interface ProfileForm {
  name: string;
  label: string;
  email: string;
  phone: string;
  city: string;
  region: string;
  summary: string;
  work: { name: string; position: string; startDate: string; endDate: string; highlights: string[] }[];
  education: { institution: string; studyType: string; area: string; endDate: string }[];
  skills: string[];
}

export interface SetupState {
  /** False until the first-time setup has been finished (or the resume and search were already in place). */
  done: boolean;
  checks: { key: string; label: string; ok: boolean; required: boolean; hint: string }[];
  profile: ProfileForm;
}

export interface FeedItem {
  id: number;
  body: string;
  status: string;
  at: number;
}

export interface NotifyState {
  /** True when texting is fully configured on the computer. */
  smsReady: boolean;
  held: number;
  categories: { key: string; label: string }[];
  feed: FeedItem[];
}

export interface ReplyDraftRow {
  id: string;
  applicationId: string;
  company: string;
  title: string;
  kind: string;
  kindLabel: string;
  to: string;
  toName: string;
  subject: string;
  body: string;
  reason: string;
  dueAt: number;
  createdAt: number;
  closedAt: number | null;
  status: string;
  /** False while the rule's wait is still running. */
  ready: boolean;
  /** Bracketed notes still to fill in before it can be sent. */
  open: string[];
  isReply: boolean;
}

export interface ReplyThread {
  id: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  paused: boolean;
  contact: string;
  items: replies.ThreadItem[];
  /** The next follow-up: when it will be drafted, or why there will not be one. */
  next: { at: number | null; n: number; why: string };
  waiting: number;
}

export interface RepliesState {
  /** True when the mailbox is connected, so Send works from the app. */
  canSend: boolean;
  canGmailDraft: boolean;
  config: replies.ReplyConfig;
  kinds: { key: string; label: string; when: string; delay: string; inbound: boolean }[];
  tokens: { token: string; means: string }[];
  queue: ReplyDraftRow[];
  recent: ReplyDraftRow[];
  threads: ReplyThread[];
}

export interface CommandCenterState {
  replies: RepliesState;
  setup: SetupState;
  notify: NotifyState;
  metrics: DashboardMetrics;
  prep: PrepRow[];
  network: NetworkState;
  mail: boolean;
  settings: Settings;
  applications: ApplicationRow[];
  answers: { question: string; answer: string }[];
  remote: { enabled: boolean; devices: number };
  dashboard: DashboardData;
  config: agent.PublicAgentConfig;
  /** Cold-start layer: the last readiness check for the connected model, and what every model call is told first. */
  brain: { check: brain.ModelCheck | null; briefing: string };
  history: agent.ChatTurn[];
  proposals: agent.Proposal[];
  paused: boolean;
}

export function state(): CommandCenterState {
  const jh = pipeline();
  let insights;
  try {
    insights = jh.insights();
  } catch {
    insights = undefined;
  }
  const applications: ApplicationRow[] = jh.list()
    .sort((x, y) => y.updatedAt - x.updatedAt)
    .slice(0, 300)
    .map((x) => ({
      id: x.id, code: x.id.slice(0, 4), company: x.job.company, title: x.job.title, location: x.job.location ?? '', status: x.status,
      fit: typeof x.job.fitScore === 'number' ? x.job.fitScore : null, url: x.job.url ?? '',
      canApply: !!x.job.url && (x.status === 'tailored' || (x.status === 'saved' && x.job.fitRoute !== 'filtered_out' && x.job.fitRoute !== 'needs_approval')), needsApproval: x.status === 'saved' && x.job.fitRoute === 'needs_approval', nextStatuses: STATUS_TRANSITIONS[x.status].filter((n) => n !== x.status),
      pending: getPending(jh.store, x.id), updatedAt: x.updatedAt,
    }));
  const settings = toSettings(jh.readPreferences());
  const rows = dashboardRows(jh.store, jh.outputDir, 'jh-doc:');
  return {
    replies: repliesState(jh),
    setup: setupState(jh, settings),
    notify: notifyState(jh),
    metrics: dashboardMetrics(rows),
    prep: prepRows(jh),
    network: networkState(jh),
    mail: jh.hasMail(),
    settings,
    applications,
    answers: loadBank(jh.answersPath).map((x) => ({ question: String(x.question), answer: String(x.answer) })),
    remote: remote.remoteStatus(REMOTE_PATH),
    dashboard: dashboardData(rows, { insights, dailyTarget: settings.dailyTarget }),
    config: agent.publicConfig(agent.loadAgentConfig(AGENT_CONFIG_PATH)),
    brain: { check: lastCheck(), briefing: briefingText() },
    history: agent.history(jh),
    proposals: agent.pendingProposals(jh),
    paused: jh.store.getKv('paused') === '1',
  };
}

// ── First-time setup ───────────────────────────────────────────────────────

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function profileFrom(master: MasterResume | null): ProfileForm {
  const b = master?.basics;
  return {
    name: b?.name ?? '', label: b?.label ?? '', email: b?.email ?? '', phone: b?.phone ?? '',
    city: b?.location?.city ?? '', region: b?.location?.region ?? '', summary: b?.summary ?? '',
    work: (master?.work ?? []).map((w) => ({ name: w.name, position: w.position, startDate: w.startDate ?? '', endDate: w.endDate ?? '', highlights: w.highlights ?? [] })),
    education: (master?.education ?? []).map((e) => ({ institution: e.institution, studyType: e.studyType ?? '', area: e.area ?? '', endDate: e.endDate ?? '' })),
    skills: [...new Set((master?.skills ?? []).flatMap((g) => g.keywords ?? []))],
  };
}

function tryMaster(jh: JobHunt): MasterResume | null {
  try {
    return jh.master();
  } catch {
    return null;
  }
}

function setupState(jh: JobHunt, settings: Settings): SetupState {
  const master = tryMaster(jh);
  const config = agent.publicConfig(agent.loadAgentConfig(AGENT_CONFIG_PATH));
  const hasSearch = settings.targetTitles.length > 0;
  const checks: SetupState['checks'] = [
    { key: 'resume', label: 'Your resume', ok: !!master, required: true, hint: master ? `${master.work?.length ?? 0} job${master.work?.length === 1 ? "" : "s"} on file` : 'Needed before anything can be scored or tailored.' },
    { key: 'search', label: 'What to look for', ok: hasSearch, required: true, hint: hasSearch ? settings.targetTitles.slice(0, 3).join(', ') : 'Add at least one target title.' },
    { key: 'model', label: 'Agent model', ok: config.hasKey || config.provider === 'openai-compatible', required: false, hint: config.hasKey ? config.model : 'Optional. Needed for chat and written cover letters. Set on the computer.' },
    { key: 'sms', label: 'Text messages', ok: jh.smsReady(), required: false, hint: jh.smsReady() ? 'Connected' : 'Optional. Add the Twilio settings and your phone number to the .env file on the computer. Until then, updates show in the app only.' },
    { key: 'mail', label: 'Email monitoring', ok: jh.hasMail(), required: false, hint: jh.hasMail() ? 'Connected' : 'Optional. Add the Gmail settings to the .env file on the computer to track replies and bounces.' },
    { key: 'boards', label: 'Job board search', ok: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY), required: false, hint: process.env.ADZUNA_APP_ID ? 'Connected' : 'Optional. Company watchlists work without it. Add an Adzuna key on the computer for wider search.' },
    { key: 'phone', label: 'Phone access', ok: remote.remoteStatus(REMOTE_PATH).enabled, required: false, hint: 'Optional. Turn on under Controls, Phone access.' },
  ];
  return { done: jh.store.getKv('setup_done') === '1' || (!!master && hasSearch), checks, profile: profileFrom(master) };
}

/** Save the resume from the setup form. Text is stored as typed; nothing is added or rewritten. */
export function saveProfile(input: unknown): string {
  const jh = pipeline();
  const i: any = input && typeof input === 'object' ? input : {};
  const old = tryMaster(jh);
  const name = str(i.name, 120);
  if (!name) throw new Error('Add your name.');
  const lines = (v: unknown, max = 30) => (Array.isArray(v) ? v.map((x) => str(x, 600)).filter(Boolean).slice(0, max) : []);
  const work = (Array.isArray(i.work) ? i.work : []).slice(0, 20)
    .map((w: any) => ({ name: str(w?.name, 120), position: str(w?.position, 120), startDate: str(w?.startDate, 20), endDate: str(w?.endDate, 20), highlights: lines(w?.highlights) }))
    .filter((w: ProfileForm['work'][number]) => w.name && w.position);
  if (!work.length) throw new Error('Add at least one job with an employer and a title.');
  const skills = [...new Set(lines(i.skills, 80).map((k) => k.slice(0, 60)))];
  const oldSkills = [...new Set((old?.skills ?? []).flatMap((g) => g.keywords ?? []))];
  const next: MasterResume = {
    ...(old ?? {}),
    basics: {
      ...(old?.basics ?? {}), name,
      label: str(i.label, 120) || undefined, email: str(i.email, 160) || undefined, phone: str(i.phone, 40) || undefined, summary: str(i.summary, 1500) || undefined,
      location: { ...(old?.basics?.location ?? {}), city: str(i.city, 80) || undefined, region: str(i.region, 80) || undefined },
    },
    work: work.map((w: ProfileForm['work'][number]) => {
      const prior = old?.work?.find((o) => o.name === w.name && o.position === w.position);
      return { ...(prior ?? {}), name: w.name, position: w.position, startDate: w.startDate || undefined, endDate: w.endDate || undefined, highlights: w.highlights };
    }),
    education: (Array.isArray(i.education) ? i.education : []).slice(0, 10)
      .map((e: any) => ({ institution: str(e?.institution, 160), studyType: str(e?.studyType, 80) || undefined, area: str(e?.area, 120) || undefined, endDate: str(e?.endDate, 20) || undefined }))
      .filter((e: { institution: string }) => e.institution),
    // Keep the existing skill groups when the list itself did not change.
    skills: skills.join('|') === oldSkills.join('|') && old?.skills ? old.skills : skills.length ? [{ name: 'Skills', keywords: skills }] : [],
  };
  jh.saveMaster(next);
  return 'Resume saved.';
}

/** Read a JSON Resume file the person uploads and save it as the master resume. */
export function importResumeJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON. Upload a JSON Resume file, or fill in the form.');
  }
  pipeline().saveMaster(parsed as MasterResume);
  return 'Resume imported.';
}

export function completeSetup(): string {
  const jh = pipeline();
  const s = setupState(jh, toSettings(jh.readPreferences()));
  const missing = s.checks.filter((c) => c.required && !c.ok).map((c) => c.label);
  if (missing.length) throw new Error(`Still needed: ${missing.join(', ')}.`);
  jh.store.setKv('setup_done', '1');
  return 'Setup finished.';
}

// ── Notifications ──────────────────────────────────────────────────────────

function notifyState(jh: JobHunt): NotifyState {
  return {
    smsReady: jh.smsReady(),
    held: jh.heldNotifications(),
    categories: NOTIFY_CATEGORIES.map((key) => ({ key, label: CATEGORY_LABEL[key] })),
    feed: jh.store.recentNotifications(40).map((n) => ({ id: n.id, body: n.body, status: n.status, at: n.createdAt })),
  };
}

/** The feed alone, for the page to poll without reloading everything. */
export function notifications(): { feed: FeedItem[]; held: number } {
  const n = notifyState(pipeline());
  return { feed: n.feed, held: n.held };
}

export async function testNotification(): Promise<string> {
  const jh = pipeline();
  await jh.textNow('[Job] Test from Armour Pursuit. Notifications are working.');
  return jh.smsReady() ? 'Test text sent to your phone.' : 'Texting is not connected on the computer yet, so nothing was sent. The test is in the notification list.';
}

// ── Reply workshop ─────────────────────────────────────────────────────────

const REPLY_STATUSES: ApplicationStatus[] = ['applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer', 'rejected'];

function repliesState(jh: JobHunt): RepliesState {
  const now = Date.now();
  const config = replies.replyConfig(jh.readPreferences());
  const drafts = replies.loadDrafts(jh.store);
  const apps = new Map(jh.list().map((a) => [a.id, a]));
  const row = (d: replies.ReplyDraft): ReplyDraftRow => {
    const a = apps.get(d.applicationId);
    return {
      id: d.id, applicationId: d.applicationId, company: a?.job.company ?? 'Removed application', title: a?.job.title ?? '', kind: d.kind, kindLabel: replies.KIND_INFO[d.kind].label,
      to: d.to ?? '', toName: d.toName ?? '', subject: d.subject, body: d.body, reason: d.reason, dueAt: d.dueAt, createdAt: d.createdAt, closedAt: d.closedAt, status: d.status,
      ready: d.dueAt <= now, open: replies.placeholders(`${d.subject}\n${d.body}`), isReply: !!d.inReplyTo,
    };
  };
  const threads: ReplyThread[] = [...apps.values()]
    .filter((a) => REPLY_STATUSES.includes(a.status) || drafts.some((d) => d.applicationId === a.id))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
    .map((a) => {
      const contact = replies.bestContact(jh.store, a);
      return {
        id: a.id, company: a.job.company, title: a.job.title, status: a.status, paused: jh.store.getKv(replies.pausedKey(a.id)) === '1',
        contact: contact ? [contact.name, contact.email].filter(Boolean).join(', ') : '',
        items: replies.exchange(jh.store, a, drafts), next: replies.followupPlan(jh.store, a, config, drafts),
        waiting: drafts.filter((d) => d.applicationId === a.id && d.status === 'pending').length,
      };
    });
  return {
    canSend: jh.canSendMail(), canGmailDraft: jh.canDraftMail(), config,
    kinds: replies.REPLY_KINDS.map((key) => ({ key, ...replies.KIND_INFO[key] })), tokens: replies.TOKENS,
    queue: drafts.filter((d) => d.status === 'pending').sort((a, b) => a.dueAt - b.dueAt).map(row),
    recent: drafts.filter((d) => d.status !== 'pending').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 20).map(row),
    threads,
  };
}

/** Save the reply rules. Everything is clamped; unknown keys are dropped. */
export function saveReplyRules(input: unknown): string {
  const jh = pipeline();
  const prefs = jh.readPreferences();
  jh.writePreferences({ ...prefs, responses: replies.replyConfig({ responses: input }) } as any);
  return 'Reply rules saved.';
}

export function resetReplyRule(kind: string): string {
  const jh = pipeline();
  if (!(replies.REPLY_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown rule.');
  const prefs = jh.readPreferences();
  const cfg = replies.replyConfig(prefs);
  cfg.rules[kind as replies.ReplyKind] = { ...replies.DEFAULT_REPLY_CONFIG.rules[kind as replies.ReplyKind] };
  jh.writePreferences({ ...prefs, responses: cfg } as any);
  return 'Wording reset to the original.';
}

/** What a rule would write, using rules that may not be saved yet. Saves nothing. */
export function previewReply(kind: string, applicationId: string | null, rules: unknown) {
  if (!(replies.REPLY_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown rule.');
  const jh = pipeline();
  const cfg = replies.replyConfig(rules ? { responses: rules } : jh.readPreferences());
  return replies.previewRule(jh.replyDeps, cfg, kind as replies.ReplyKind, applicationId);
}

export type ReplyAction = 'save' | 'send' | 'gmail' | 'done' | 'dismiss' | 'snooze';

/**
 * One action on one draft, always from the person pressing a button.
 * "send" is the only thing in the app that emails anyone, and it sends that
 * one draft once.
 */
export async function replyAction(id: string, action: ReplyAction, input: { to?: string; subject?: string; body?: string; days?: number } = {}): Promise<string> {
  const jh = pipeline();
  const deps = jh.replyDeps;
  if (action === 'dismiss') return replies.dismissDraft(jh.store, id) && 'Draft dismissed.';
  if (action === 'snooze') return replies.snoozeDraft(jh.store, id, input.days ?? 2) && `Snoozed for ${input.days ?? 2} days.`;
  // Anything else keeps the edits on screen first, so what is sent is what the person sees.
  if (input.subject != null || input.body != null || input.to != null) replies.editDraft(jh.store, id, input);
  if (action === 'save') return 'Draft saved.';
  if (action === 'done') return replies.markDraftSent(jh.store, id) && 'Marked as sent by you.';
  if (action === 'gmail') return (await replies.draftToGmail(deps, id)) && 'Saved to your Gmail Drafts. It is not sent.';
  if (action === 'send') {
    const d = await replies.sendDraft(deps, id);
    return `Sent to ${d.to}.`;
  }
  throw new Error('Unknown action.');
}

export async function composeReply(applicationId: string, kind: string): Promise<string> {
  if (!(replies.REPLY_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown kind of message.');
  const d = await replies.composeNow(pipeline().replyDeps, applicationId, kind as replies.ReplyKind);
  return `${replies.KIND_INFO[d.kind].label} drafted. It is in your queue.`;
}

export function pauseFollowups(applicationId: string, paused: boolean): string {
  const jh = pipeline();
  if (!jh.list().some((a) => a.id === applicationId)) throw new Error('That application is gone.');
  jh.store.setKv(replies.pausedKey(applicationId), paused ? '1' : '0');
  return paused ? 'Follow-ups paused for this application.' : 'Follow-ups back on for this application.';
}

// ── Resume workshop ────────────────────────────────────────────────────────

/** The connected agent model as a plain text generator, or null when none is set up. */
function agentGenerate(): GenerateText | null {
  const cfg = usableConfig();
  if (!cfg) return null;
  return brain.smartGenerate((system, messages) => agent.callModel(cfg, system, messages), briefingText());
}

function usableConfig() {
  const cfg = agent.loadAgentConfig(AGENT_CONFIG_PATH);
  return cfg && (cfg.apiKey || cfg.provider === 'openai-compatible') ? cfg : null;
}

/** What every model call is told first. Empty until a resume is on file. */
function briefingText(opts: { withoutStanding?: boolean } = {}): string {
  const jh = pipeline();
  const master = tryMaster(jh);
  if (!master) return '';
  const prefs: any = jh.readPreferences() ?? {};
  return brain.briefing(master, opts.withoutStanding ? { ...prefs, agentInstructions: '' } : prefs, brain.voiceSamples(jh.store));
}

const CHECK_KEY = 'brain_check';

/** The last readiness check, if it was run against the model that is connected now. */
function lastCheck(): brain.ModelCheck | null {
  const check = readJson<brain.ModelCheck | null>(pipeline().store.getKv(CHECK_KEY), null);
  return check && check.model === agent.publicConfig(agent.loadAgentConfig(AGENT_CONFIG_PATH)).model ? check : null;
}

/** Run five small graded tasks on the connected model, using made-up sample data only. */
export async function runModelCheck(): Promise<brain.ModelCheck> {
  const cfg = usableConfig();
  if (!cfg) throw new Error('No model is connected. Add one first.');
  const sampleApp: any = { id: 'sample', status: 'screening', job: { title: 'QA Automation Engineer', company: 'Example Co', descriptionText: '' } };
  const sampleBrief: any = { process: [], difficulty: { label: 'Moderate', reasons: [] }, pay: { min: null, max: null, basis: 'The posting lists no pay.' } };
  const check = await brain.modelCheck((system, messages) => agent.callModel(cfg, system, messages), agent.publicConfig(cfg).model, {
    chatSystem: agent.SYSTEM_PROMPT,
    coachSystem: planner.coachSystem(sampleApp, sampleBrief, [], planner.EMPTY_PLAN, 'Sam'),
    parseActions: agent.parseReply,
  });
  pipeline().store.setKv(CHECK_KEY, JSON.stringify(check));
  return check;
}

function workshopApp(id: string) {
  const jh = pipeline();
  const app = jh.list().find((a) => a.id === id);
  if (!app) throw new Error('That application is gone.');
  return { jh, app, master: jh.master() };
}

export type ResumeWorkshopState = workshop.WorkshopView & { hasModel: boolean; ownResults: ReturnType<typeof workshop.keywordOutcomes> };

/** Everything the resume workshop shows for one application. */
export async function resumeWorkshop(id: string): Promise<ResumeWorkshopState> {
  const { jh, app, master } = workshopApp(id);
  return { ...(await workshop.workshopView(jh.store, app, master)), hasModel: !!agentGenerate(), ownResults: workshop.keywordOutcomes(jh.store, master) };
}

/** Save the person's choices (which lines, wording, summary, skills, notes). The files are not rewritten until they save a version. */
export async function saveResumeChoices(id: string, input: unknown): Promise<ResumeWorkshopState> {
  const { jh } = workshopApp(id);
  workshop.saveChoices(jh.store, id, workshop.sanitizeChoices(input, workshop.loadChoices(jh.store, id)));
  return resumeWorkshop(id);
}

/** Ask the agent to suggest wording. Suggestions that add a fact are thrown out. */
export async function resumeSuggest(id: string, ids: string[] = []): Promise<{ message: string; view: ResumeWorkshopState }> {
  const { jh, app, master } = workshopApp(id);
  const generate = agentGenerate();
  if (!generate) throw new Error('Connect a model under Controls, Agent first. Everything else in the workshop works without one.');
  const r = await workshop.suggestWording(jh.store, app, master, generate, ids);
  const message = r.accepted || r.rejected
    ? `${r.accepted} wording suggestion${r.accepted === 1 ? '' : 's'} ready to review.${r.rejected ? ` ${r.rejected} thrown out for adding something that is not on your resume.` : ''}`
    : 'Nothing to reword. Turn on a few lines that match the posting first.';
  return { message, view: await resumeWorkshop(id) };
}

/** Read the sources that may be read and count the company's own language. */
export async function resumeResearch(id: string, urls: string[] = []): Promise<{ message: string; view: ResumeWorkshopState }> {
  const { jh, app, master } = workshopApp(id);
  const r = await workshop.researchCompany(jh.store, app, master, { urls, generate: agentGenerate() });
  const read = r.sources.filter((s) => ['posting', 'board', 'page', 'notes'].includes(s.kind)).length;
  const skipped = r.sources.length - read;
  return { message: `Research done: ${read} source${read === 1 ? '' : 's'} read${skipped ? `, ${skipped} not read (see why below)` : ''}.`, view: await resumeWorkshop(id) };
}

/** One button: research the company, then suggest wording for the strongest lines. */
export async function resumeAgentPass(id: string, urls: string[] = []): Promise<{ message: string; view: ResumeWorkshopState }> {
  const research = await resumeResearch(id, urls);
  if (!agentGenerate()) return { message: `${research.message} No model is connected, so no wording was suggested.`, view: research.view };
  const wording = await resumeSuggest(id);
  return { message: `${research.message} ${wording.message}`, view: wording.view };
}

/** Make the workshop version this application's resume and write the files. */
export async function resumeSaveVersion(id: string): Promise<{ message: string; view: ResumeWorkshopState }> {
  const { jh } = workshopApp(id);
  const out = await jh.saveWorkshopResume(id);
  refreshDashboard();
  const pages = out.pdfAudit?.pages;
  const fit = pages == null ? '' : pages > (out.pdfAudit?.pageBudget ?? 1) ? ` It runs to ${pages} pages. Turn off a few lines if you want one page.` : ` It fits on ${pages} page${pages === 1 ? '' : 's'}.`;
  return { message: `Saved. This is now the resume used for ${out.job.company}.${fit}`, view: await resumeWorkshop(id) };
}

export async function resumeReset(id: string): Promise<{ message: string; view: ResumeWorkshopState }> {
  const { jh } = workshopApp(id);
  await jh.resetWorkshopResume(id);
  refreshDashboard();
  return { message: 'Back to the automatic version.', view: await resumeWorkshop(id) };
}

// ── Game plan: one role's brief, skill builder, plan of attack and coach ───

export interface GamePlanDate extends planner.PlanDate {
  /** "email" dates were read from an invite and are not editable here. */
  source: 'you' | 'email';
}

export interface GamePlan {
  id: string;
  company: string;
  title: string;
  status: ApplicationStatus;
  brief: planner.RoleBrief;
  sourceLabels: Record<planner.Source, string>;
  gaps: planner.GapPlan[];
  attack: ReturnType<typeof planner.attackPlan>;
  dates: GamePlanDate[];
  done: string[];
  confidence: Record<string, number>;
  processNotes: string;
  profile: planner.CoachProfile;
  chat: { role: 'user' | 'assistant'; content: string }[];
  /** Practice questions written by the model for this posting. Empty until asked for. */
  questions: string[];
  concernTopics: { key: string; label: string }[];
  hasModel: boolean;
  /** Whether date reminders can reach the phone right now. */
  reminders: { sms: boolean; note: string };
}

function emailDate(jh: JobHunt, id: string): GamePlanDate | null {
  const when = readJson<{ start?: number; end?: number } | null>(jh.store.getKv(`interview_${id}`), null);
  if (!when?.start) return null;
  return { id: 'email', kind: 'interview', label: 'Interview (from their email)', at: when.start, minutes: Math.max(10, Math.round(((when.end ?? when.start + 30 * 60_000) - when.start) / 60_000)), remind: [60], source: 'email' };
}

/** Everything the Prep screen shows for one role. Estimates carry their source. */
export function gamePlan(id: string): GamePlan {
  const { jh, app, master } = workshopApp(id);
  const prefs: any = jh.readPreferences();
  const stored = planner.loadPlan(jh.store, id);
  const fromEmail = emailDate(jh, id);
  const dates: GamePlanDate[] = [...stored.dates.map((d) => ({ ...d, source: 'you' as const })), ...(fromEmail && !stored.dates.some((d) => Math.abs(d.at - fromEmail.at) < 10 * 60_000) ? [fromEmail] : [])].sort((a, b) => a.at - b.at);
  const plan = { ...stored, dates };
  const brief = planner.roleBrief(jh.store, app, master, prefs);
  const gaps = planner.gapPlans(app, master, plan);
  const pack = buildPrepPack(master, app.job);
  const n = notifySettingsFor(prefs);
  return {
    id, company: app.job.company, title: app.job.title, status: app.status, brief, sourceLabels: planner.SOURCE_LABEL, gaps,
    attack: planner.attackPlan(app, gaps, { covered: pack.covered.length, technical: pack.technical, behavioral: pack.behavioral }, plan, brief),
    dates, done: stored.done, confidence: stored.confidence, processNotes: stored.processNotes, profile: stored.profile, chat: stored.chat, questions: stored.questions,
    concernTopics: planner.CONCERN_TOPICS.map((t) => ({ key: t.key, label: t.label })), hasModel: !!agentGenerate(),
    reminders: n,
  };
}

function notifySettingsFor(prefs: any): { sms: boolean; note: string } {
  const s = notifySettings(prefs);
  if (!s.enabled) return { sms: false, note: 'Notifications are switched off in Controls, so reminders will not go out.' };
  if (s.off.includes('interview')) return { sms: false, note: 'Interview notifications are switched off in Controls, so reminders will not go out.' };
  if (!s.sms) return { sms: false, note: 'Texting is off, so reminders show in the bell on this page only.' };
  return { sms: true, note: 'Reminders go out as texts, and also show in the bell on this page.' };
}

/** Save dates, ticks, confidence, notes and the self-check concerns for one role. */
export function saveGamePlan(id: string, input: unknown): GamePlan {
  const { jh } = workshopApp(id);
  const stored = planner.loadPlan(jh.store, id);
  const i: any = input && typeof input === 'object' ? input : {};
  // Dates read from an email are kept where they are; only the person's own dates are saved here.
  const next = planner.sanitizePlan({ ...i, dates: (Array.isArray(i.dates) ? i.dates : []).filter((d: any) => d?.id !== 'email') }, stored);
  planner.savePlan(jh.store, id, next);
  return gamePlan(id);
}

/** One turn with the coach. What the person says reshapes the plan. */
export async function coachSend(id: string, text: string): Promise<{ message: string; view: GamePlan }> {
  const { jh, app, master } = workshopApp(id);
  const cfg = usableConfig();
  if (!cfg) throw new Error('No model is connected. Use the self-check instead, or add a model under Controls.');
  const message = text.trim();
  if (!message) throw new Error('Type a message.');
  const out = await planner.coachTurn(jh.store, app, master, jh.readPreferences(), message, brain.smartChat((system, messages) => agent.callModel(cfg, system, messages), briefingText(), 'coach', true, (t) => !!planner.parseCoach(t).profile));
  return { message: out.changed ? 'Your plan was updated from this conversation.' : '', view: gamePlan(id) };
}

/** Forget the coach conversation. Concerns already noted stay until the person removes them. */
export function coachClear(id: string): GamePlan {
  const { jh } = workshopApp(id);
  planner.savePlan(jh.store, id, { ...planner.loadPlan(jh.store, id), chat: [] });
  return gamePlan(id);
}

/** Ask the model for practice questions written from this posting. */
export async function planQuestions(id: string): Promise<{ message: string; view: GamePlan }> {
  const { jh, app } = workshopApp(id);
  const generate = agentGenerate();
  if (!generate) throw new Error('No model is connected. Add one under Controls.');
  const qs = await planner.roleQuestions(jh.store, app, generate);
  return { message: `${qs.length} practice questions written from this posting.`, view: gamePlan(id) };
}

// ── Interview prep ─────────────────────────────────────────────────────────

const PREP_LIVE: ApplicationStatus[] = ['assessment', 'screening', 'interviewing', 'offer'];
const PREP_EARLY: ApplicationStatus[] = ['applied', 'acknowledged'];

function readJson<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Prep for everything in an interview stage, plus the most recent sent applications. */
function prepRows(jh: JobHunt): PrepRow[] {
  let master;
  try {
    master = jh.master();
  } catch {
    return []; // no master resume yet
  }
  const apps = jh.list().sort((a, b) => b.updatedAt - a.updatedAt);
  const picked = [...apps.filter((a) => PREP_LIVE.includes(a.status)), ...apps.filter((a) => PREP_EARLY.includes(a.status)).slice(0, 8)].slice(0, 24);
  return picked.map((a) => {
    const pack = buildPrepPack(master, a.job);
    const saved = readJson<{ notes?: Record<string, string>; practiced?: string[] }>(jh.store.getKv(`prepnotes_${a.id}`), {});
    return {
      id: a.id, company: a.job.company, title: a.job.title, status: a.status, live: PREP_LIVE.includes(a.status),
      covered: pack.covered, uncovered: pack.uncovered, technical: pack.technical, behavioral: pack.behavioral, askThem: pack.askThem,
      notes: saved.notes ?? {}, practiced: saved.practiced ?? [],
    };
  });
}

/** Save the person's own prep notes and practiced ticks for one application. */
export function savePrep(id: string, input: { notes: Record<string, string>; practiced: string[] }): string {
  const jh = pipeline();
  if (!jh.list().some((a) => a.id === id)) throw new Error('That application is gone.');
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.notes ?? {}).slice(0, 40)) if (/^[a-z0-9]{1,12}$/.test(k) && typeof v === 'string' && v.trim()) notes[k] = v.slice(0, 2000);
  const practiced = (input.practiced ?? []).filter((q) => typeof q === 'string').slice(0, 60).map((q) => q.slice(0, 300));
  jh.store.setKv(`prepnotes_${id}`, JSON.stringify({ notes, practiced }));
  return 'Prep notes saved.';
}

/** Write the printable prep pack and return its path inside the documents folder. */
export function prepDocument(id: string): string {
  const jh = pipeline();
  const app = jh.list().find((a) => a.id === id);
  if (!app) throw new Error('That application is gone.');
  if (!jh.writePrep(id)) throw new Error('No documents folder is configured.');
  return `${documentDirName(app.job, app.id)}/prep.html`;
}

// ── LinkedIn network (from the person's own Connections.csv export) ────────

const NETWORK_STATUSES: ApplicationStatus[] = ['saved', 'tailored', 'applied', 'acknowledged', 'assessment', 'screening', 'interviewing', 'offer'];

function networkState(jh: JobHunt): NetworkState {
  const connections = loadConnections(jh.connectionsPath);
  let master: ReturnType<JobHunt['master']> | null = null;
  try {
    master = jh.master();
  } catch {
    master = null;
  }
  const apps = jh.list().filter((a) => NETWORK_STATUSES.includes(a.status) && a.job.fitRoute !== 'filtered_out').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  const rows: NetworkRow[] = apps.map((a) => ({
    id: a.id, company: a.job.company, title: a.job.title, status: a.status,
    people: matchReferrals(connections, a.job.company).filter((p) => /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(p.url ?? '')).slice(0, 5).map((p) => ({
      name: `${p.firstName} ${p.lastName}`.trim(), position: p.position, url: p.url as string, ask: master ? referralAsk(p, a.job, master) : '',
    })),
    managerSearch: linkedinSearch(`${a.job.company} QA manager`),
    recruiterSearch: linkedinSearch(`${a.job.company} recruiter`),
  }));
  const counts = new Map<string, { company: string; n: number }>();
  for (const c of connections) {
    const k = companyKey(c.company);
    if (!k) continue;
    const cur = counts.get(k) ?? { company: c.company, n: 0 };
    cur.n++;
    counts.set(k, cur);
  }
  const withPeople = rows.filter((r) => r.people.length);
  return {
    connections: connections.length,
    atTracked: new Set(withPeople.flatMap((r) => r.people.map((p) => p.url))).size,
    companiesWithPeople: new Set(withPeople.map((r) => companyKey(r.company))).size,
    inQa: connections.filter((c) => /\b(qa|quality|test|tester|sdet)\b/i.test(c.position)).length,
    topCompanies: [...counts.values()].sort((a, b) => b.n - a.n || a.company.localeCompare(b.company)).slice(0, 8),
    rows: rows.sort((a, b) => b.people.length - a.people.length),
  };
}

/** Store the Connections.csv file from LinkedIn's own data export. Stays on the computer. */
export function saveConnections(csv: string): string {
  const people = parseConnections(csv);
  if (!people.length) throw new Error('That does not look like LinkedIn\'s Connections.csv (no "First Name" and "Company" columns found).');
  const path = pipeline().connectionsPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv, { mode: 0o600 });
  return `Imported ${people.length} connections.`;
}

export function saveConfig(input: { provider: agent.Provider; model?: string; apiKey?: string | null; baseURL?: string | null }) {
  return agent.saveAgentConfig(AGENT_CONFIG_PATH, input);
}

export async function send(text: string) {
  const jh = pipeline();
  const okBlock = (t: string) => { const r = agent.parseReply(t); return r.actions.length > 0 || r.dropped === 0; };
  const brief = briefingText({ withoutStanding: true }); // chat adds the standing instructions itself
  return agent.chat(jh, agent.loadAgentConfig(AGENT_CONFIG_PATH), text, jh.readPreferences(), (cfg, system, messages) =>
    brain.smartChat((sys, msgs) => agent.callModel(cfg, sys, msgs), brief, 'actions', false, okBlock)(system, messages));
}

export async function apply(id: string) {
  const jh = pipeline();
  const result = await agent.applyProposal(jh, id, { read: () => jh.readPreferences(), write: (p) => jh.writePreferences(p) }, { startApply: (appId) => startApply(appId) });
  try {
    jh.writeDashboard();
  } catch {
    /* dashboard file is optional */
  }
  return result;
}

export function dismiss(id: string) {
  agent.dismissProposal(pipeline(), id);
}

export function clear() {
  agent.clearChat(pipeline());
}

const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.png': 'image/png' };

/** One generated document, only from inside the documents folder. */
export function readDocument(relPath: string): { name: string; mime: string; base64: string } {
  const root = pipeline().outputDir;
  if (!root) throw new Error('No documents folder is configured.');
  const full = resolve(root, relPath);
  if (!full.startsWith(resolve(root) + sep) || !MIME[extname(full)]) throw new Error('Not a document.');
  if (!existsSync(full)) throw new Error('That file is not there any more.');
  return { name: full.slice(resolve(root).length + 1), mime: MIME[extname(full)], base64: readFileSync(full).toString('base64') };
}

// ── Controls ───────────────────────────────────────────────────────────────

/** Save the whole settings form. Everything is validated and clamped first. */
export function saveSettings(input: unknown): Settings {
  const jh = pipeline();
  jh.writePreferences(mergeSettings(jh.readPreferences(), input));
  return toSettings(jh.readPreferences());
}

export type AppAction = 'approve' | 'skip' | 'applied' | ApplicationStatus;

/** One-tap actions on an application row. */
export async function applicationAction(id: string, action: AppAction): Promise<string> {
  const jh = pipeline();
  const app = jh.list().find((a) => a.id === id);
  if (!app) throw new Error('That application is gone.');
  let message: string;
  if (action === 'approve') message = await jh.handleReply(`YES ${id}`);
  else if (action === 'skip') message = await jh.handleReply(`SKIP ${id}`);
  else if (action === 'applied') message = await jh.handleReply(`APPLIED ${id}`);
  else if ((APPLICATION_STATUSES as readonly string[]).includes(action)) {
    await jh.setStatus(id, action as ApplicationStatus, 'set from command center');
    message = `${app.job.company} is now ${action}.`;
  } else throw new Error('Unknown action.');
  refreshDashboard();
  return message;
}

export async function addPosting(url: string): Promise<string> {
  const r = await pipeline().addPosting({ url });
  refreshDashboard();
  return `Added ${r.job.company}, ${r.job.title}${r.fit ? ` (fit ${r.fit.score})` : ''}.`;
}

export async function automation(action: 'pause' | 'resume' | 'discover' | 'inbox'): Promise<string> {
  const jh = pipeline();
  if (action === 'pause') return jh.handleReply('PAUSE');
  if (action === 'resume') return jh.handleReply('RESUME');
  if (action === 'inbox') {
    if (!jh.hasMail()) throw new Error('Email is not connected yet. Add the Gmail settings on the computer.');
    const scan = await jh.scanInbox();
    refreshDashboard();
    return `Inbox checked: ${scan.scanned} read, ${scan.updated.length} matched to applications.`;
  }
  const r = await jh.discover();
  refreshDashboard();
  return `Discovery: ${r.fetched} fetched, ${r.added.length} added, ${r.filteredOut} filtered out.`;
}

/** Add or change an answer in the bank. An empty answer deletes it. */
export function saveBankAnswer(question: string, answer: string): string {
  const jh = pipeline();
  if (!answer.trim()) {
    const bank = loadBank(jh.answersPath).filter((a) => String(a.question).trim().toLowerCase() !== question.trim().toLowerCase());
    writeFileSync(jh.answersPath, `${JSON.stringify(bank, null, 2)}\n`);
    return 'Answer removed.';
  }
  saveAnswer(jh.answersPath, question, answer);
  return 'Answer saved.';
}

/** Answer open form question n (1-based) for one application. */
export function answerPending(id: string, n: number, answer: string): string {
  return `Saved answer for "${pipeline().answerQuestion(id, n, answer)}".`;
}

function refreshDashboard() {
  try {
    pipeline().writeDashboard();
  } catch {
    /* dashboard file is optional */
  }
}

// ── Live apply session ─────────────────────────────────────────────────────

export function startApply(id: string, opts: { launch?: session.Launch; narrow?: boolean } = {}): Promise<string> {
  const jh = pipeline();
  const s = toSettings(jh.readPreferences());
  return session.start(jh, id, { waitMinutes: s.applyWaitMinutes, window: s.applyWindow, launch: opts.launch, narrow: opts.narrow });
}

export const applyView = (image = true) => session.view({ image });
export const applyInput = (ev: session.SessionInput) => session.input(ev);
export const applySubmit = () => session.submit();
export const applyStop = () => session.stop();

// ── Phone access ───────────────────────────────────────────────────────────

export const remoteStatus = () => remote.remoteStatus(REMOTE_PATH);
export const remoteLogin = (passcode: string, label?: string) => remote.login(REMOTE_PATH, passcode, label);
export const remoteValid = (token: string | undefined | null) => remote.validSession(REMOTE_PATH, token);
/** Only call for requests made on the computer itself. An empty passcode turns phone access off. */
export function remoteSetPasscode(passcode: string | null) {
  if (passcode) remote.setPasscode(REMOTE_PATH, passcode);
  else remote.disableRemote(REMOTE_PATH);
  return remote.remoteStatus(REMOTE_PATH);
}
