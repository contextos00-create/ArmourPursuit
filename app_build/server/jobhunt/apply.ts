'use strict';

/**
 * Assisted apply. Opens the posting's application form in a visible browser on
 * the job seeker's computer, fills what we know (contact details, resume PDF,
 * cover letter, answers already approved in the answer bank), takes a
 * screenshot, and stops before Submit. The person reviews and clicks Submit
 * themselves; we watch for the confirmation page and mark the application
 * applied.
 *
 * Rules:
 *   - Never guesses an answer. Anything not in the profile or the answer bank
 *     is left blank and texted as a question (reply ANSWER code n text).
 *   - Work authorization, sponsorship and demographic questions are only ever
 *     answered from the bank.
 *   - A visible CAPTCHA stops automation; the person handles it.
 *   - Caps: dailyLimit per day (default 10), 2 per company per 30 days, and a
 *     site pauses after 3 failures in a row.
 *   - autoSubmit exists but is off by default, and even when on it submits only
 *     when every required field is filled and there is no CAPTCHA.
 *
 * Works with a puppeteer or playwright Page: everything except file upload
 * goes through page.evaluate.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { JobHuntStore } from './store';
import { normalizeTerm } from './text';
import type { Application, JobPosting, MasterResume } from './types';

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'other';

export interface FormField {
  id: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'combobox' | 'radio' | 'checkbox' | 'file';
  required: boolean;
  options: string[];
  filled: boolean;
}

export interface Answer {
  question: string;
  answer: string;
}

export interface ApplyProfile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
  currentCompany: string;
  currentTitle: string;
}

export interface FillPlan {
  actions: { field: FormField; value: string; source: 'profile' | 'bank' | 'file' }[];
  unanswered: FormField[];
}

export interface ApplyOutcome {
  ats: Ats;
  url: string;
  filled: number;
  unanswered: { label: string; required: boolean }[];
  captcha: boolean;
  screenshot: string | null;
  submitted: boolean;
  confirmed: boolean;
}

/** Minimal page surface shared by puppeteer and playwright. */
export interface FormPage {
  goto(url: string, opts?: any): Promise<unknown>;
  evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: any): Promise<T>;
  url(): string;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  setInputFiles?(selector: string, files: string): Promise<void>;
  $?(selector: string): Promise<any>;
  click?(selector: string): Promise<void>;
  keyboard?: { type(text: string): Promise<void>; press(key: string): Promise<void> };
}

export function detectAts(url: string): Ats {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  return 'other';
}

/** The application form URL for a posting (Lever and Ashby keep it on /apply or /application). */
export function applyUrl(url: string): string {
  const ats = detectAts(url);
  if (ats === 'lever' && !/\/apply\/?$/.test(url)) return url.replace(/\/?$/, '/apply');
  if (ats === 'ashby' && !/\/application\/?$/.test(url)) return url.replace(/\/?$/, '/application');
  return url;
}

export function profileFrom(master: MasterResume): ApplyProfile {
  const b = master.basics;
  const parts = b.name.trim().split(/\s+/);
  const profile = (net: RegExp) => b.profiles?.find((p) => net.test(p.network))?.url ?? '';
  const current = master.work?.find((w) => !w.endDate);
  const loc = [b.location?.city, b.location?.region].filter(Boolean).join(', ');
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    fullName: b.name.trim(),
    email: b.email ?? '',
    phone: b.phone ?? '',
    location: loc,
    linkedin: profile(/linkedin/i),
    github: profile(/github/i),
    website: b.url ?? '',
    currentCompany: current?.name ?? '',
    currentTitle: current?.position ?? '',
  };
}

/** Questions we never answer from the profile, only from the bank. */
export const SENSITIVE = /(authori[sz]ed|legally|sponsor|visa|citizen|clearance|gender|race|ethnic|hispanic|latin|veteran|disabilit|sexual orientation|transgender|pronoun|criminal|convict|felony|salary|compensation|pay expectation|age\b|date of birth)/i;

const PROFILE_RULES: [RegExp, keyof ApplyProfile][] = [
  [/^(legal )?first name|^given name|^preferred first name/, 'firstName'],
  [/^(legal )?last name|^surname|^family name/, 'lastName'],
  [/^(full )?name$|^full name|^your name|^legal name/, 'fullName'],
  [/e-?mail/, 'email'],
  [/phone|mobile/, 'phone'],
  [/linkedin/, 'linkedin'],
  [/github/, 'github'],
  [/website|portfolio|personal (site|url)/, 'website'],
  [/^(current )?(location|city)\b|where are you (located|based)/, 'location'],
  [/current (company|employer)|^company$|^org/, 'currentCompany'],
  [/current (job )?title/, 'currentTitle'],
];

export function questionKey(label: string): string {
  return normalizeTerm(label.replace(/\*/g, '')).replace(/\s*(required|optional)$/, '').trim();
}

export function lookupAnswer(bank: Answer[], label: string): string | null {
  const key = questionKey(label);
  const hit = bank.find((a) => questionKey(a.question) === key);
  return hit ? hit.answer : null;
}

function pickOption(options: string[], answer: string): string | null {
  const a = normalizeTerm(answer);
  return options.find((o) => normalizeTerm(o) === a)
    ?? options.find((o) => normalizeTerm(o).startsWith(a))
    ?? options.find((o) => a.length > 2 && normalizeTerm(o).includes(a))
    ?? null;
}

/** Decide what to put in each field. Pure; exported for tests. */
export function planFill(fields: FormField[], profile: ApplyProfile, bank: Answer[], files: { resume: string | null; coverLetter: string | null }): FillPlan {
  const plan: FillPlan = { actions: [], unanswered: [] };
  for (const f of fields) {
    if (f.filled) continue;
    const key = questionKey(f.label);
    if (f.kind === 'file') {
      const path = /cover/.test(key) ? files.coverLetter : /resume|cv\b/.test(key) || f.required ? files.resume : null;
      if (path) plan.actions.push({ field: f, value: path, source: 'file' });
      else if (f.required) plan.unanswered.push(f);
      continue;
    }
    let value: string | null = null;
    let source: 'profile' | 'bank' = 'bank';
    // Profile answers only for short labels; long questions ("Are you subject to any employment agreements...") need the bank.
    if (!SENSITIVE.test(key) && !/\?/.test(f.label) && key.split(' ').length <= 6) {
      const rule = PROFILE_RULES.find(([re]) => re.test(key));
      if (rule && profile[rule[1]]) {
        value = profile[rule[1]];
        source = 'profile';
      }
    }
    if (value === null) value = lookupAnswer(bank, f.label);
    if (value !== null && f.options.length) value = pickOption(f.options, value);
    if (value) plan.actions.push({ field: f, value, source });
    else plan.unanswered.push(f);
  }
  return plan;
}

// ── In-page helpers (run inside the browser) ───────────────────────────────
// Core compiles without the DOM lib, so browser globals are declared loosely here.
declare const document: any;
declare const getComputedStyle: any;
declare const location: any;
declare const HTMLInputElement: any;
declare const HTMLTextAreaElement: any;
declare const Event: any;

/* istanbul ignore next */
function readFieldsInPage(): FormField[] {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: any) => {
    const r = (el as any).getBoundingClientRect();
    const st = getComputedStyle(el as any);
    return st.display !== 'none' && st.visibility !== 'hidden' && (r.width > 0 || r.height > 0 || (el as any).type === 'file');
  };
  // Text of a label-ish element without the text of any controls or options inside it.
  const textOf = (node: any): string => {
    const c = node.cloneNode(true);
    c.querySelectorAll('input, select, option, textarea, button, ul[data-qa], [role=listbox], .application-field, [aria-live]').forEach((x: any) => x.remove());
    return clean(c.textContent);
  };
  const LABELISH = 'legend, label, .application-label, [class*=question-title], [class*=label]';
  // Walk up from a control to the nearest question label that is not just an option's own label.
  const questionFor = (el: any, skipOwn: boolean): string => {
    let up = el.parentElement;
    for (let i = 0; i < 6 && up && up !== document.body; i++, up = up.parentElement) {
      const isOption = (l: any) => !!l.querySelector('input[type=radio], input[type=checkbox]') || ['radio', 'checkbox'].includes(l.control?.type);
      const lab = Array.from(up.querySelectorAll(LABELISH)).find((l: any) => !(skipOwn && l.contains(el)) && !isOption(l) && textOf(l));
      if (lab) return textOf(lab);
    }
    return '';
  };
  const labelFor = (el: any): string => {
    const own = el.labels?.[0];
    if (own && textOf(own)) return textOf(own);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(' ').map((id: string) => document.getElementById(id)?.textContent ?? '').join(' '));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    return questionFor(el, false) || clean(el.getAttribute('placeholder') || el.getAttribute('name'));
  };
  const out: FormField[] = [];
  const groups = new Map<string, FormField>();
  let n = 0;
  const controls = Array.from(document.querySelectorAll('input, textarea, select')) as any;
  for (const el of controls) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
    if (type !== 'file' && !visible(el)) continue;
    // react-select keeps a hidden required mirror input next to the real combobox.
    if (el.getAttribute('aria-hidden') === 'true' && el.getAttribute('tabindex') === '-1') continue;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(labelFor(el));
    if (type === 'radio' || type === 'checkbox') {
      const box = el.closest('fieldset, [role=group], [role=radiogroup]');
      const legend = box?.querySelector('legend');
      const question = (legend && textOf(legend)) || questionFor(el, true) || clean(el.name);
      const optLabel = el.labels?.[0] ? clean(el.labels[0].textContent) : clean(el.value);
      const groupRequired = required || /[*✱]/.test(question);
      const groupKey = `${type}:${el.name || question}`;
      let g = groups.get(groupKey);
      if (!g) {
        g = { id: `g${n++}`, label: question, kind: type as 'radio' | 'checkbox', required: groupRequired, options: [], filled: false };
        groups.set(groupKey, g);
        out.push(g);
      }
      el.setAttribute('data-jh-id', `${g.id}:${g.options.length}`);
      g.options.push(optLabel);
      if (el.checked) g.filled = true;
      continue;
    }
    const id = `f${n++}`;
    el.setAttribute('data-jh-id', id);
    const combo = el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete');
    const kind = type === 'file' ? 'file' : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : combo ? 'combobox' : 'text';
    const options = el.tagName === 'SELECT' ? (Array.from((el as any).options) as any[]).filter((o) => o.value).map((o) => clean(o.text)) : [];
    const filled = kind === 'file' ? !!(el.files && el.files.length) : kind === 'select' ? !!el.value : !!el.value.trim();
    out.push({ id, label: labelFor(el), kind, required, options, filled });
  }
  return out;
}

/* istanbul ignore next */
function setValueInPage(arg: { id: string; kind: string; value: string; options: string[] }): boolean {
  if (arg.kind === 'radio' || arg.kind === 'checkbox') {
    const i = arg.options.indexOf(arg.value);
    const el = document.querySelector(`[data-jh-id="${arg.id}:${i}"]`) as any;
    if (!el) return false;
    if (!el.checked) el.click();
    return el.checked;
  }
  const el = document.querySelector(`[data-jh-id="${arg.id}"]`) as any;
  if (!el) return false;
  if (el.tagName === 'SELECT') {
    const s = el as any;
    const opt = (Array.from(s.options) as any[]).find((o) => o.text.replace(/\s+/g, ' ').trim() === arg.value);
    if (!opt) return false;
    s.value = opt.value;
  } else {
    // Native setter so React-controlled inputs (Ashby) see the change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, arg.value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

/* istanbul ignore next */
function captchaInPage(): boolean {
  const frames = Array.from(document.querySelectorAll('iframe')) as any[];
  const big = (el: any) => {
    const r = el.getBoundingClientRect();
    return r.width >= 150 && r.height >= 60 && getComputedStyle(el).visibility !== 'hidden';
  };
  // A visible checkbox or challenge needs a person. The invisible reCAPTCHA badge does not.
  return frames.some((f) => /hcaptcha|turnstile|challenges\.cloudflare|recaptcha\/api2\/(anchor\?.*size=normal|bframe)/.test(f.src) && big(f))
    || Array.from(document.querySelectorAll('.h-captcha, .cf-turnstile, .g-recaptcha:not([data-size=invisible])')).some(big);
}

/* istanbul ignore next */
function confirmedInPage(): boolean {
  const t = (document.body?.innerText ?? '').slice(0, 5000);
  return /thank you for (applying|your application|your interest)|application (has been )?(submitted|received)|we('ve| have) received your application|successfully submitted/i.test(t)
    || /confirmation|thank|submitted|success/i.test(location.pathname);
}

/* istanbul ignore next */
function clickSubmitInPage(): boolean {
  const buttons = Array.from(document.querySelectorAll('button, input[type=submit]')) as any[];
  const b = buttons.find((x) => /submit( application)?|apply/i.test((x as any).value || x.innerText || ''));
  if (!b) return false;
  b.click();
  return true;
}

export async function readFields(page: FormPage): Promise<FormField[]> {
  return page.evaluate(readFieldsInPage);
}

async function upload(page: FormPage, id: string, path: string) {
  const sel = `[data-jh-id="${id}"]`;
  if (page.setInputFiles) return page.setInputFiles(sel, path);
  const handle = await page.$!(sel);
  await handle.uploadFile(path);
}

export async function fillForm(page: FormPage, plan: FillPlan): Promise<number> {
  let filled = 0;
  for (const a of plan.actions) {
    if (a.field.kind === 'file') {
      await upload(page, a.field.id, a.value);
      filled++;
    } else if (a.field.kind === 'combobox') {
      // Searchable dropdowns (react-select and similar): type the answer and take the first match.
      if (!page.click || !page.keyboard) continue;
      await page.click(`[data-jh-id="${a.field.id}"]`);
      await page.keyboard.type(a.value);
      await new Promise((r) => setTimeout(r, 600));
      await page.keyboard.press('Enter');
      filled++;
    } else if (await page.evaluate(setValueInPage, { id: a.field.id, kind: a.field.kind, value: a.value, options: a.field.options })) {
      filled++;
    }
  }
  return filled;
}

export const hasCaptcha = (page: FormPage) => page.evaluate(captchaInPage);
export const isConfirmed = (page: FormPage) => page.evaluate(confirmedInPage);

// ── Answer bank (local JSON file, never in git) ────────────────────────────

export function loadBank(path: string): Answer[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

export function saveAnswer(path: string, question: string, answer: string): Answer[] {
  const bank = loadBank(path).filter((a) => questionKey(a.question) !== questionKey(question));
  bank.push({ question: question.replace(/\s*[*✱]\s*$/, '').trim(), answer: answer.trim() });
  writeFileSync(path, `${JSON.stringify(bank, null, 2)}\n`);
  return bank;
}

// ── Caps ───────────────────────────────────────────────────────────────────

export interface ApplyLimits {
  dailyLimit?: number;
  perCompany?: number;
  maxSiteFailures?: number;
}

export function checkCaps(store: JobHuntStore, app: Application & { job: JobPosting }, limits: ApplyLimits = {}, now = Date.now()): string | null {
  const ats = detectAts(app.job.url ?? '');
  if (Number(store.getKv(`apply_fail_${ats}`) ?? 0) >= (limits.maxSiteFailures ?? 3)) {
    return `${ats} is paused after ${limits.maxSiteFailures ?? 3} failed runs in a row. Run apply-reset ${ats} after checking it.`;
  }
  const day = new Date(now).toISOString().slice(0, 10);
  if (Number(store.getKv(`apply_count_${day}`) ?? 0) >= (limits.dailyLimit ?? 10)) return `Daily limit of ${limits.dailyLimit ?? 10} reached.`;
  const company = normalizeTerm(app.job.company);
  const since = now - 30 * 86_400_000;
  const recent = store.listApplications().filter((a) => a.id !== app.id && normalizeTerm(a.job.company) === company && a.appliedAt && a.appliedAt >= since);
  if (recent.length >= (limits.perCompany ?? 2)) return `Already applied to ${app.job.company} ${recent.length} times in 30 days.`;
  return null;
}

export function recordRun(store: JobHuntStore, ats: Ats, ok: boolean, now = Date.now()) {
  if (ok) {
    store.setKv(`apply_fail_${ats}`, '0');
    const key = `apply_count_${new Date(now).toISOString().slice(0, 10)}`;
    store.setKv(key, String(Number(store.getKv(key) ?? 0) + 1));
  } else {
    store.setKv(`apply_fail_${ats}`, String(Number(store.getKv(`apply_fail_${ats}`) ?? 0) + 1));
  }
}

// ── Pending questions (for the ANSWER text reply) ──────────────────────────

export function setPending(store: JobHuntStore, applicationId: string, questions: string[]) {
  store.setKv(`apply_pending_${applicationId}`, JSON.stringify(questions));
}

export function getPending(store: JobHuntStore, applicationId: string): string[] {
  try {
    return JSON.parse(store.getKv(`apply_pending_${applicationId}`) ?? '[]');
  } catch {
    return [];
  }
}

// ── One assisted run ───────────────────────────────────────────────────────

export interface RunOptions {
  profile: ApplyProfile;
  bank: Answer[];
  files: { resume: string | null; coverLetter: string | null };
  screenshotPath: string | null;
  autoSubmit?: boolean;
  /** How long to wait for the person to click Submit. 0 = return right after filling. */
  waitForSubmitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function assistedApply(page: FormPage, url: string, opts: RunOptions): Promise<ApplyOutcome> {
  const target = applyUrl(url);
  await page.goto(target, { waitUntil: 'networkidle' } as any).catch(() => page.goto(target));
  const fields = await readFields(page);
  if (!fields.length) throw new Error('No form fields found on the page.');
  const plan = planFill(fields, opts.profile, opts.bank, opts.files);
  const filled = await fillForm(page, plan);
  const captcha = await hasCaptcha(page);
  if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath, fullPage: true });
  const outcome: ApplyOutcome = {
    ats: detectAts(url), url: target, filled, captcha, screenshot: opts.screenshotPath, submitted: false, confirmed: false,
    unanswered: plan.unanswered.map((f) => ({ label: f.label, required: f.required })),
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (opts.autoSubmit && !captcha && !plan.unanswered.some((f) => f.required)) {
    outcome.submitted = await page.evaluate(clickSubmitInPage);
  }
  const deadline = Date.now() + (opts.waitForSubmitMs ?? 0);
  while (true) {
    const confirmed = await isConfirmed(page).catch(() => false);
    if (confirmed) {
      outcome.confirmed = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? 3000);
  }
  return outcome;
}
