'use strict';

/**
 * Job-hunt pipeline facade: capture a posting, generate a tailored resume and
 * cover letter from the master resume, track status, text on every change,
 * and watch the mailbox for bounce-backs.
 *
 * Route-free Core service. Load it in-process from a TanStack Start server
 * function (see contextos-server-bootstrap.server.ts) or drive it from the CLI
 * in ./cli.ts. Nothing here submits an application for you.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanForBounces, startBounceMonitor, type BounceScanResult } from './bounce-monitor';
import { writeCoverLetter } from './cover-letter';
import { createGmailSource, gmailConfigFromEnv, type MailSource } from './gmail';
import { defaultPdfTools, renderResumePdf, type PdfAudit, type PdfTools } from './pdf';
import { fetchPosting } from './postings';
import { discover as runDiscovery, type DiscoveryPreferences, type DiscoveryResult } from './discovery';
import { scanInbox as runInboxScan, type InboxScanResult } from './inbox';
import { sendDigest, sweepStale } from './lifecycle';
import { isPaused, processReplies, handleReply } from './replies';
import { createTwilioInbox, type SmsInbox } from './sms';
import { attachSmsNotifier, createTwilioSender, smsConfigFromEnv, type SmsSender } from './sms';
import { gateSms, type NotifyCategory } from './notify';
import { JobHuntStore } from './store';
import { scoreFit, type FitScore } from './scoring';
import { renderResumeHtml, renderResumeMarkdown, tailorResume } from './tailor';
import { documentDirName } from './text';
import { dashboardRows, renderDashboard } from './dashboard';
import { interviewTimeFromEmail, onStatusChanged, recordInterview, runFollowups, type FollowupDeps } from './followups';
import { onInboundEmail } from './responses';
import { buildDraft, loadChoices, saveChoices } from './resume-workshop';
import { learnedBoost, salaryIntel, skillsGap, whatWorks } from './insights';
import { buildPrepPack } from './prep';
import { loadConnections, matchReferrals, referralAsk } from './referrals';
import { assistedApply, isConfirmed, checkCaps, detectAts, getPending, loadBank, profileFrom, recordRun, saveAnswer as saveBankAnswer, setPending, type ApplyLimits, type ApplyOutcome, type FormPage } from './apply';
import type { Application, ApplicationStatus, GenerateText, JobPosting, MasterResume, NewJobPosting } from './types';

export * from './types';
export { JobHuntStore } from './store';
export type { FitScore, SearchPreferences } from './scoring';

export const DATA_DIR = process.env.JOBHUNT_DATA_DIR ?? join(__dirname, '..', 'data', 'jobhunt');
export const DEFAULT_MASTER_RESUME_PATH = join(DATA_DIR, 'master-resume.json');
export const DEFAULT_PREFERENCES_PATH = join(DATA_DIR, 'preferences.json');
export const DEFAULT_ANSWERS_PATH = join(DATA_DIR, 'answers.json');
export const DEFAULT_CONNECTIONS_PATH = join(DATA_DIR, 'connections.csv');

export interface JobHuntOptions {
  store?: JobHuntStore;
  /** null disables LLM rewriting (deterministic selection + template letter). */
  generate?: GenerateText | null;
  sms?: SmsSender;
  mail?: MailSource | null;
  masterResume?: MasterResume;
  masterResumePath?: string;
  preferences?: DiscoveryPreferences;
  smsInbox?: SmsInbox | null;
  fetchImpl?: typeof fetch;
  outputDir?: string | null;
  /** PDF renderer; null skips PDFs. Default: headless Chromium via puppeteer. */
  pdf?: PdfTools | null;
  /** 1 by default; 2 for staff or executive profiles. */
  pageBudget?: number;
  /** Tailor automatically when a posting scores >= 80. Default true. */
  autoTailor?: boolean;
  /** Approved answers for application questions. Default data/jobhunt/answers.json. */
  answersPath?: string;
  /** LinkedIn Connections.csv export. Default data/jobhunt/connections.csv. */
  connectionsPath?: string;
}

/**
 * The model connected in Controls, looked up each time it is needed.
 * With no model connected the call fails, and tailoring and cover letters
 * fall back to their no-model path (select and reorder only, template letter).
 */
export function coreGenerate(): GenerateText {
  return async (prompt, options = {}) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const agent = require('./agent');
    const cfg = agent.loadAgentConfig(process.env.JOBHUNT_AGENT_CONFIG ?? join(DATA_DIR, 'agent.json'));
    if (!cfg || (!cfg.apiKey && cfg.provider !== 'openai-compatible')) throw new Error('No model is connected.');
    return agent.callModel(cfg, options.system ?? '', [{ role: 'user', content: prompt }]);
  };
}

export function validateMasterResume(value: any): MasterResume {
  if (!value || typeof value !== 'object') throw new Error('Master resume must be a JSON object (JSON Resume format).');
  if (!value.basics?.name) throw new Error('Master resume needs basics.name.');
  if (!Array.isArray(value.work) || !value.work.length) throw new Error('Master resume needs at least one entry in "work".');
  for (const [i, w] of value.work.entries()) {
    if (!w.name || !w.position) throw new Error(`work[${i}] needs "name" (employer) and "position".`);
    if (w.highlights && !Array.isArray(w.highlights)) throw new Error(`work[${i}].highlights must be an array of strings.`);
  }
  return value as MasterResume;
}


export function createJobHunt(options: JobHuntOptions = {}) {
  const store = options.store ?? new JobHuntStore();
  const smsConfig = options.sms ? null : smsConfigFromEnv();
  // Every text passes the person's notification rules (notify.ts) before it goes anywhere.
  const sms = gateSms(options.sms ?? createTwilioSender(smsConfig), { store, prefs: () => loadPreferences() });
  const gmailConfig = options.mail === undefined ? gmailConfigFromEnv() : null;
  const mail: MailSource | null = options.mail !== undefined ? options.mail : gmailConfig ? createGmailSource(gmailConfig) : null;
  const generate = options.generate === undefined ? coreGenerate() : options.generate;
  const smsInbox = options.smsInbox !== undefined ? options.smsInbox : createTwilioInbox(smsConfigFromEnv());
  const outputDir = options.outputDir === undefined ? join(DATA_DIR, 'documents') : options.outputDir;
  const detachSms = attachSmsNotifier(store, sms);

  const masterPath = options.masterResumePath ?? process.env.JOBHUNT_MASTER_RESUME ?? DEFAULT_MASTER_RESUME_PATH;

  /** Save the master resume (the in-memory object when one was passed in). */
  function saveMaster(next: MasterResume) {
    const valid = validateMasterResume(next);
    if (options.masterResume) {
      for (const k of Object.keys(options.masterResume)) delete (options.masterResume as any)[k];
      Object.assign(options.masterResume, valid);
      return;
    }
    mkdirSync(dirname(masterPath), { recursive: true });
    writeFileSync(masterPath, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  }

  function loadMaster(): MasterResume {
    if (options.masterResume) return validateMasterResume(options.masterResume);
    const path = masterPath;
    if (!existsSync(path)) throw new Error(`No master resume at ${path}. Save your resume as JSON Resume there (see jobhunt/README.md).`);
    return validateMasterResume(JSON.parse(readFileSync(path, 'utf8')));
  }

  const connectionsPath = options.connectionsPath ?? process.env.JOBHUNT_CONNECTIONS ?? DEFAULT_CONNECTIONS_PATH;

  const preferencesPath = process.env.JOBHUNT_PREFERENCES ?? DEFAULT_PREFERENCES_PATH;

  /** Replace the saved preferences (the in-memory object when one was passed in). */
  function writePreferences(next: DiscoveryPreferences & { autoSubmit?: boolean }) {
    if (options.preferences) {
      for (const k of Object.keys(options.preferences)) delete (options.preferences as any)[k];
      Object.assign(options.preferences, next);
      return;
    }
    mkdirSync(dirname(preferencesPath), { recursive: true });
    writeFileSync(preferencesPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  function loadPreferences(): DiscoveryPreferences & { autoSubmit?: boolean } {
    if (options.preferences) return options.preferences;
    return existsSync(preferencesPath) ? JSON.parse(readFileSync(preferencesPath, 'utf8')) : {};
  }

  const ROUTE_TEXT = { auto_tailor: 'tailoring now', needs_approval: 'needs your OK to tailor', filtered_out: 'filtered out' } as const;

  /**
   * Capture a posting, score it, text the result, and auto-tailor at >= 80.
   * Filtered-out postings are kept (for analytics) but get no documents.
   */
  async function addPosting(input: { url: string } | NewJobPosting, extra: { contactEmail?: string | null; notes?: string | null } = {}) {
    const posting = 'descriptionText' in input ? input : await fetchPosting(input.url, options.fetchImpl);
    let job = store.upsertJob(posting);
    const application = store.createApplication(job.id, extra);
    let fit: FitScore | null = null;
    try {
      fit = scoreFit(loadMaster(), job, loadPreferences());
      store.setJobFit(job.id, { score: fit.score, route: fit.route, detail: fit });
      job = store.getJob(job.id)!;
      const code = application.id.slice(0, 4);
      const prefs = loadPreferences();
      const ask = fit.route === 'needs_approval' ? ` Reply YES ${code} or SKIP ${code}.` : '';
      const hot = fit.route !== 'filtered_out' && fit.score >= (prefs.hotScore ?? 85);
      let referral = '';
      if (fit.route !== 'filtered_out') {
        const people = matchReferrals(loadConnections(connectionsPath), job.company).slice(0, 3);
        for (const p of people) {
          store.upsertContact({ applicationId: application.id, name: `${p.firstName} ${p.lastName}`.trim(), title: `${p.position} (your connection)`, email: p.email, linkedinUrl: p.url, source: 'referral' });
        }
        if (people.length) {
          referral = ` You know ${people.map((p) => `${p.firstName} ${p.lastName}`.trim()).join(', ')} there, ask for a referral.`;
          if (outputDir) {
            const dir = join(outputDir, documentDirName(job, application.id));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'referral-ask.txt'), people.map((p) => `To: ${p.firstName} ${p.lastName}${p.url ? ` (${p.url})` : ''}\n\n${referralAsk(p, job, loadMaster())}`).join('\n\n---\n\n'));
          }
        }
      }
      const body = `[Job ${code}] ${hot ? 'TOP MATCH, apply fast: ' : 'New: '}${job.company}, ${job.title}. Fit ${fit.score}, ${ROUTE_TEXT[fit.route]}${fit.hardFilter ? ` (${fit.hardFilter})` : ''}.${referral}${ask}`;
      const sent = await sms.send(body, hot ? 'top_match' : 'new_posting');
      store.logNotification({ applicationId: application.id, channel: 'sms', body, ...sent });
    } catch (error) {
      // No master resume yet: keep the posting, skip scoring.
      console.error('[jobhunt] scoring skipped:', (error as Error).message);
    }
    let tailored: Awaited<ReturnType<typeof tailor>> | null = null;
    if (fit?.route === 'auto_tailor' && options.autoTailor !== false && !isPaused(store)) tailored = await tailor(application.id);
    return { job, application: store.getApplication(application.id)!, fit, tailored };
  }

  /** Generate (or regenerate) the tailored resume and cover letter. */
  async function tailor(applicationId: string, opts: { force?: boolean; fresh?: boolean } = {}) {
    const app = store.getApplication(applicationId);
    if (!app) throw new Error(`Unknown application ${applicationId}`);
    const job = store.getJob(app.jobId)!;
    if (job.fitRoute === 'filtered_out' && !opts.force) {
      throw new Error(`${job.company} was filtered out (fit ${job.fitScore}). Pass force to tailor anyway.`);
    }
    const master = loadMaster();
    const tailored = await tailorResume(master, job, { generate });
    // A version the person built in the resume workshop is never overwritten by automatic tailoring.
    const workshop = loadChoices(store, app.id);
    const custom = !!workshop.savedAt && !opts.fresh;
    if (custom) {
      const draft = await buildDraft(master, job, workshop);
      tailored.resume = draft.resume;
      tailored.markdown = renderResumeMarkdown(draft.resume);
      tailored.html = renderResumeHtml(draft.resume, job);
      tailored.printed = draft.lines.filter((l) => l.on).map((l) => ({ section: l.section, parentIndex: l.parentIndex, text: l.text, score: l.score, order: l.order }));
    }
    const letter = await writeCoverLetter(master, job, tailored, { generate });
    let pdf: Buffer | null = null;
    let pdfAudit: PdfAudit | null = null;
    let pdfError: string | null = null;
    const pdfTools = options.pdf === undefined ? defaultPdfTools() : options.pdf;
    if (pdfTools) {
      try {
        // The person chose these lines, so nothing is trimmed to fit the page; the page count is reported instead.
        const rendered = await renderResumePdf(tailored, job, { tools: pdfTools, pageBudget: options.pageBudget, ...(custom ? { maxTrims: 0 } : {}) });
        pdf = rendered.pdf;
        pdfAudit = rendered.audit;
        tailored.markdown = rendered.markdown;
        tailored.html = rendered.html;
      } catch (error) {
        pdfError = (error as Error).message;
        console.error('[jobhunt] PDF render skipped:', pdfError);
      }
    }
    const report = { ...tailored.report, pdf: pdfAudit, pdfError, workshop: custom };
    const resumeDoc = store.saveDocument(app.id, 'resume', { markdown: tailored.markdown, html: tailored.html, report });
    const letterDoc = store.saveDocument(app.id, 'cover_letter', letter);
    const files: string[] = [];
    if (outputDir) {
      const dir = join(outputDir, documentDirName(job, app.id));
      mkdirSync(dir, { recursive: true });
      const write = (name: string, body: string) => {
        writeFileSync(join(dir, name), body);
        files.push(join(dir, name));
      };
      write('resume.md', tailored.markdown);
      write('resume.html', tailored.html);
      if (pdf) {
        writeFileSync(join(dir, 'resume.pdf'), pdf);
        files.push(join(dir, 'resume.pdf'));
      }
      write('cover-letter.md', letter.markdown);
      write('cover-letter.html', letter.html);
      write('cover-letter.txt', `${letter.markdown.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').trim()}\n`);
      write('report.json', JSON.stringify({ resume: report, coverLetter: letter.report }, null, 2));
    }
    if (['saved', 'tailored'].includes(app.status)) {
      await store.setStatus(app.id, 'tailored', { source: 'system', reason: `fit ${tailored.report.fitScore}%${tailored.report.gaps.length ? `, gaps: ${tailored.report.gaps.slice(0, 3).join(', ')}` : ''}` });
    }
    return { job, resume: resumeDoc, coverLetter: letterDoc, files, pdfAudit };
  }

  const requireMail = () => {
    if (!mail) throw new Error('Gmail is not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).');
    return mail;
  };
  const approve = (id: string) => tailor(id, { force: true });
  const answersPath = options.answersPath ?? process.env.JOBHUNT_ANSWERS ?? DEFAULT_ANSWERS_PATH;
  const followDeps: FollowupDeps = { store, sms, mail, master: loadMaster, outputDir, prefs: () => loadPreferences() };

  /** Write the interview prep pack next to the application's documents. */
  function writePrep(applicationId: string): string | null {
    const app = store.listApplications().find((a) => a.id === applicationId);
    if (!app || !outputDir) return null;
    const pack = buildPrepPack(loadMaster(), app.job);
    const dir = join(outputDir, documentDirName(app.job, app.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prep.md'), pack.markdown);
    writeFileSync(join(dir, 'prep.html'), pack.html);
    return join(dir, 'prep.html');
  }

  const detachFollow = store.onStatusChange(async (change) => {
    try {
      if (['screening', 'interviewing'].includes(change.event.toStatus) && !store.getKv(`prep_${change.application.id}`)) {
        store.setKv(`prep_${change.application.id}`, String(Date.now()));
        const path = writePrep(change.application.id);
        if (path) await text(change.application.id, `[Job ${change.application.id.slice(0, 4)}] Interview prep pack ready: ${path}`, 'interview');
      }
      await onStatusChanged(followDeps, change.application.id, change.event.toStatus);
    } catch (error) {
      console.error('[jobhunt] follow-through failed:', (error as Error).message);
    }
  });

  async function onMatchedEmail(applicationId: string, category: string, raw: string) {
    let when: ReturnType<typeof interviewTimeFromEmail> = null;
    if (category === 'interview') {
      when = interviewTimeFromEmail(raw, Date.now());
      if (when) await recordInterview(followDeps, applicationId, when);
    }
    // Keep the email for the exchange view and draft the reply the rules call for. Drafts only.
    await onInboundEmail(followDeps, applicationId, category, raw, when);
  }

  function insights() {
    const master = loadMaster();
    return { gap: skillsGap(store, master), salary: salaryIntel(store), works: whatWorks(store) };
  }

  async function text(applicationId: string | null, body: string, category: NotifyCategory = 'apply') {
    const sent = await sms.send(body, category);
    store.logNotification({ applicationId, channel: 'sms', body, ...sent });
  }

  /** Save the person's answer to pending question n (1-based) for an application. */
  function answerQuestion(applicationId: string, n: number, answer: string): string {
    const pending = getPending(store, applicationId);
    const question = pending[n - 1];
    if (!question) throw new Error(pending.length ? `Question ${n} not found, there are ${pending.length}.` : 'No questions are waiting for this posting.');
    saveBankAnswer(answersPath, question, answer);
    return question;
  }

  /**
   * Fill the application form in `page` (a visible browser on the job seeker's
   * computer) and stop before Submit. Texts what is left to do, then waits
   * up to waitForSubmitMs for the confirmation page and marks it applied.
   */
  async function applyWith(page: FormPage, applicationId: string, opts: { waitForSubmitMs?: number; limits?: ApplyLimits; autoSubmit?: boolean; onFilled?: (outcome: ApplyOutcome) => void; shouldStop?: () => boolean } = {}): Promise<ApplyOutcome> {
    if (isPaused(store)) throw new Error('Automation is paused. Text RESUME first.');
    let app = store.listApplications().find((a) => a.id === applicationId);
    if (!app) throw new Error(`No application ${applicationId}`);
    if (!app.job.url) throw new Error('This posting has no URL to apply at.');
    if (!['saved', 'tailored'].includes(app.status)) throw new Error(`Status is ${app.status}, nothing to apply for.`);
    const prefs = loadPreferences() as DiscoveryPreferences & { autoSubmit?: boolean; apply?: ApplyLimits };
    const capped = checkCaps(store, app, { dailyLimit: prefs.dailyTarget, ...prefs.apply, ...opts.limits });
    if (capped) throw new Error(capped);
    if (app.status === 'saved' || !outputDir || !existsSync(join(outputDir, documentDirName(app.job, app.id), 'resume.pdf'))) {
      await tailor(app.id, { force: true });
      app = store.listApplications().find((a) => a.id === applicationId)!;
    }
    const dir = outputDir ? join(outputDir, documentDirName(app.job, app.id)) : null;
    const file = (name: string) => (dir && existsSync(join(dir, name)) ? join(dir, name) : null);
    const code = app.id.slice(0, 4);
    const ats = detectAts(app.job.url!);
    let outcome: ApplyOutcome;
    try {
      outcome = await assistedApply(page, app.job.url!, {
        profile: profileFrom(loadMaster()),
        bank: loadBank(answersPath),
        files: { resume: file('resume.pdf'), coverLetter: file('cover-letter.txt') },
        screenshotPath: dir ? join(dir, 'apply-screenshot.png') : null,
        autoSubmit: opts.autoSubmit ?? prefs.autoSubmit ?? false,
        waitForSubmitMs: 0,
      });
    } catch (error) {
      recordRun(store, ats, false);
      await text(app.id, `[Job ${code}] Could not fill ${app.job.company}: ${(error as Error).message.slice(0, 100)}`);
      throw error;
    }
    recordRun(store, ats, outcome.filled > 0);
    setPending(store, app.id, outcome.unanswered.map((u) => u.label));
    const lines = [`[Job ${code}] Ready for review: ${app.job.company}, ${app.job.title}. Filled ${outcome.filled} fields.`];
    if (outcome.captcha) lines.push('There is a CAPTCHA on the page, solve it before Submit.');
    if (outcome.unanswered.length) {
      lines.push(`Needs answers: ${outcome.unanswered.map((u, i) => `${i + 1}) ${u.label}${u.required ? '' : ' (optional)'}`).join(' ')}`);
      lines.push(`Reply ANSWER ${code} 1 your answer, and it is saved for next time.`);
    }
    lines.push(outcome.submitted ? 'Submitted automatically.' : 'Check the browser window and click Submit.');
    await text(app.id, lines.join(' '));
    opts.onFilled?.(outcome);
    if (!outcome.confirmed && (opts.waitForSubmitMs ?? 0) > 0) {
      const deadline = Date.now() + opts.waitForSubmitMs!;
      while (Date.now() < deadline && !outcome.confirmed && !opts.shouldStop?.()) {
        await new Promise((r) => setTimeout(r, opts.shouldStop ? 1000 : 3000));
        outcome.confirmed = await isConfirmed(page).catch(() => false);
      }
    }
    if (outcome.confirmed) {
      await store.setStatus(app.id, 'applied', { source: 'system', reason: `confirmation page seen (${ats})` });
    }
    return outcome;
  }

  /** Find, rank and admit up to the daily target; each admitted posting is texted and maybe auto-tailored. */
  async function discover(): Promise<DiscoveryResult & { added: string[] }> {
    const r = await runDiscovery(store, loadMaster(), loadPreferences(), { fetchImpl: options.fetchImpl });
    const added: string[] = [];
    for (const { posting } of r.admitted) {
      try {
        added.push((await addPosting(posting)).application.id);
      } catch (error) {
        r.errors.push(`${posting.company}: ${(error as Error).message}`);
      }
    }
    return { ...r, added };
  }

  return {
    store,
    addPosting,
    discover,
    scanInbox: (): Promise<InboxScanResult> => runInboxScan(store, requireMail(), sms, { onMatched: onMatchedEmail }),
    runFollowups: () => runFollowups(followDeps),
    /** Store, mail and rules for the reply workshop (responses.ts). */
    replyDeps: followDeps,
    /** Save the resume built in the workshop as this application's resume, and write its files. */
    async saveWorkshopResume(applicationId: string) {
      saveChoices(store, applicationId, { ...loadChoices(store, applicationId), savedAt: Date.now() });
      return tailor(applicationId, { force: true });
    },
    /** Throw away the workshop version and go back to automatic tailoring. */
    async resetWorkshopResume(applicationId: string) {
      store.setKv(`resume_ws_${applicationId}`, 'null');
      return tailor(applicationId, { force: true, fresh: true });
    },
    /** True when the mailbox connection can send (the person still presses Send each time). */
    canSendMail: () => !!mail?.send,
    canDraftMail: () => !!mail?.createDraft,
    recordInterview: (id: string, when: { start: number; end: number; location?: string | null }) => recordInterview(followDeps, id, { location: null, ...when, source: 'text' }),
    writePrep,
    master: loadMaster,
    saveMaster,
    /** True when Twilio is fully configured, so texts really go out. */
    smsReady: () => !!smsConfig,
    /** Send whatever quiet hours held back. */
    flushNotifications: () => sms.flush(),
    heldNotifications: () => sms.held(),
    /** One text straight to the person, outside the rules. Used by the test button. */
    textNow: (body: string) => text(null, body, 'reply'),
    insights,
    learnedBoost: (job: JobPosting) => learnedBoost(store, job),
    connectionsPath,
    outputDir,
    readPreferences: () => JSON.parse(JSON.stringify(loadPreferences())),
    writePreferences,
    sweepStale: (days?: number) => sweepStale(store, { days }),
    sendDigest: () => sendDigest(store, sms),
    processReplies: () => (smsInbox ? processReplies(smsInbox, { store, sms, approve, answer: answerQuestion }) : Promise.resolve(0)),
    handleReply: (body: string) => handleReply(body, { store, sms, approve, answer: answerQuestion }),
    applyWith,
    answerQuestion,
    answersPath,
    hasMail: () => !!mail,
    hasSmsInbox: () => !!smsInbox,
    tailor,
    /** Approve a needs-approval posting: tailor it. */
    approve,
    setStatus: (id: string, status: ApplicationStatus, reason?: string) => store.setStatus(id, status, { reason, source: 'user' }),
    recordSentEmail: (id: string, messageId: string, to?: string) => store.recordSentEmail(id, messageId, to),
    setContactEmail: (id: string, email: string | null) => store.setContactEmail(id, email),
    list: (status?: ApplicationStatus) => store.listApplications({ status }),
    history: (id: string) => store.history(id),
    /** Add or update a hiring manager or recruiter for an application. */
    addContact: (id: string, c: { name?: string | null; title?: string | null; email?: string | null; linkedinUrl?: string | null }) =>
      store.upsertContact({ applicationId: id, ...c, source: 'manual' }),
    /** Render the tracking dashboard. Written next to the documents folder so its links resolve. */
    writeDashboard(path?: string): string {
      let extra: ReturnType<typeof insights> | undefined;
      try {
        extra = insights();
      } catch {
        extra = undefined; // no master resume yet
      }
      const html = renderDashboard(dashboardRows(store, outputDir, 'documents'), { insights: extra, dailyTarget: Number(loadPreferences()?.dailyTarget) || undefined });
      const target = path ?? (outputDir ? join(outputDir, '..', 'dashboard.html') : null);
      if (target) {
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, html);
      }
      return target ?? html;
    },
    scanBounces: (): Promise<BounceScanResult> => scanForBounces(store, requireMail(), sms),
    startBounceMonitor: (intervalMs?: number) => {
      if (!mail) throw new Error('Gmail is not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN).');
      return startBounceMonitor(store, mail, sms, { intervalMs });
    },
    close() {
      detachSms();
      detachFollow();
      store.close();
    },
  };
}

export type JobHunt = ReturnType<typeof createJobHunt>;
export type { Application, JobPosting };
