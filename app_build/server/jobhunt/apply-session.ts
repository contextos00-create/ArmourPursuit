'use strict';

/**
 * One live application run that the command center can watch and steer.
 * A browser on this computer opens the form and fills it; the page polls
 * view() for a picture of it and relays the person's clicks and typing with
 * input(), so they can fix a field, solve a CAPTCHA themselves and press
 * Submit from any device. Nothing here solves or bypasses a CAPTCHA.
 */

import { hasCaptcha } from './apply';
import type { JobHunt } from './index';

export type SessionState = 'starting' | 'filling' | 'review' | 'applied' | 'ended' | 'failed';

export interface SessionView {
  active: boolean;
  state: SessionState | 'idle';
  applicationId: string | null;
  company: string;
  title: string;
  log: { at: number; text: string }[];
  captcha: boolean;
  filled: number;
  unanswered: { label: string; required: boolean }[];
  pageUrl: string;
  width: number;
  height: number;
  /** JPEG, base64. Empty when there is nothing to show. */
  image: string;
  windowVisible: boolean;
}

export type SessionInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number }
  /** Choose an option of the native dropdown at this point (its own popup cannot be shown in the picture). */
  | { type: 'select'; x: number; y: number; value: string }
  /** Switch the form between a phone-width and a computer-width layout. */
  | { type: 'viewport'; narrow: boolean };

export interface InputResult {
  /** Set when the click landed on a native dropdown: the page shows these options to pick from. */
  select?: { x: number; y: number; current: string; options: { value: string; text: string }[] };
}

const KEYS = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End'];
const VIEWPORT = { width: 1100, height: 760 };
const NARROW = { width: 430, height: 760 };

interface Live {
  applicationId: string;
  company: string;
  title: string;
  state: SessionState;
  log: { at: number; text: string }[];
  filled: number;
  unanswered: { label: string; required: boolean }[];
  captcha: boolean;
  browser: any;
  page: any;
  stopped: boolean;
  visible: boolean;
  lastImage: string;
  viewport: { width: number; height: number };
}

let live: Live | null = null;

export type Launch = (opts: { headless: boolean }) => Promise<{ browser: any; page: any }>;

/* istanbul ignore next */
const defaultLaunch: Launch = async ({ headless }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless, defaultViewport: VIEWPORT, args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`, ...(process.env.JOBHUNT_BROWSER_ARGS ?? '').split(' ').filter(Boolean)] });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  return { browser, page };
};

/** A window can only be shown where there is a screen to show it on. */
export function wantVisible(mode: 'auto' | 'visible' | 'hidden', env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (mode === 'hidden') return false;
  const hasScreen = platform === 'darwin' || platform === 'win32' || !!env.DISPLAY || !!env.WAYLAND_DISPLAY;
  return hasScreen;
}

function say(s: Live, text: string) {
  s.log.push({ at: Date.now(), text });
  if (s.log.length > 60) s.log.shift();
}

async function close(s: Live) {
  s.stopped = true;
  try {
    await s.browser?.close();
  } catch {
    /* already closed */
  }
}

export function isActive() {
  return !!live && ['starting', 'filling', 'review'].includes(live.state);
}

/** Start filling one application. Returns as soon as the browser is opening. */
export async function start(jh: JobHunt, applicationId: string, opts: { launch?: Launch; waitMinutes?: number; window?: 'auto' | 'visible' | 'hidden'; narrow?: boolean } = {}): Promise<string> {
  if (isActive()) throw new Error(`Already working on ${live!.company}. Stop that one first.`);
  const app = jh.list().find((a) => a.id === applicationId);
  if (!app) throw new Error('That application is gone.');
  const visible = wantVisible(opts.window ?? 'auto');
  const s: Live = {
    applicationId, company: app.job.company, title: app.job.title, state: 'starting', log: [], filled: 0, unanswered: [], captcha: false,
    browser: null, page: null, stopped: false, visible, lastImage: '', viewport: opts.narrow ? NARROW : VIEWPORT,
  };
  live = s;
  say(s, `Opening the ${app.job.company} form${visible ? ' in a window on the computer' : ''}.`);
  void (async () => {
    try {
      const { browser, page } = await (opts.launch ?? defaultLaunch)({ headless: !visible });
      s.browser = browser;
      s.page = page;
      if (s.stopped) return void (await close(s));
      await resize(s).catch(() => {});
      s.state = 'filling';
      say(s, 'Tailoring documents if needed, then filling the form.');
      const outcome = await jh.applyWith(page, applicationId, {
        waitForSubmitMs: (opts.waitMinutes ?? 30) * 60_000,
        shouldStop: () => s.stopped,
        onFilled: (o) => {
          s.filled = o.filled;
          s.unanswered = o.unanswered;
          s.captcha = o.captcha;
          s.state = 'review';
          say(s, `Filled ${o.filled} field${o.filled === 1 ? '' : 's'}.`);
          if (o.unanswered.length) say(s, `${o.unanswered.length} question${o.unanswered.length === 1 ? '' : 's'} left for you: ${o.unanswered.map((u) => u.label).join('; ').slice(0, 400)}`);
          if (o.captcha) say(s, 'There is a CAPTCHA. Solve it in the picture below, then submit.');
          say(s, o.submitted ? 'Submitted automatically. Waiting for the confirmation page.' : 'Review it, then press Submit application.');
        },
      });
      if (outcome.confirmed) {
        s.state = 'applied';
        say(s, 'Confirmation page seen. Marked as applied.');
      } else if (!s.stopped) {
        s.state = 'ended';
        say(s, 'No confirmation page seen before the wait ran out. If you did submit, mark it applied.');
      }
    } catch (error) {
      if (!s.stopped) {
        s.state = 'failed';
        say(s, `Stopped: ${(error as Error).message.split('\n')[0].slice(0, 300)}`);
      }
    } finally {
      if (s.page && !s.stopped) s.lastImage = await shot(s).catch(() => s.lastImage);
      await close(s);
    }
  })();
  return `Started ${app.job.company}.`;
}

/** Works with both puppeteer and playwright pages. */
async function resize(s: Live) {
  if (typeof s.page.setViewport === 'function') await s.page.setViewport(s.viewport);
  else if (typeof s.page.setViewportSize === 'function') await s.page.setViewportSize(s.viewport);
}

/* istanbul ignore next */
function selectAtPoint(arg: { x: number; y: number; value?: string }) {
  const d = (globalThis as any).document;
  let el = d.elementFromPoint(arg.x, arg.y);
  if (el && el.tagName === 'OPTION') el = el.parentElement;
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  if (!el || el.tagName !== 'SELECT' || el.disabled) return null;
  if (arg.value !== undefined) {
    const option = Array.from(el.options as any[]).find((o) => o.value === arg.value);
    if (!option) return null;
    const setter = Object.getOwnPropertyDescriptor((globalThis as any).HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, arg.value); else el.value = arg.value;
    el.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
    el.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true }));
  }
  return { current: String(el.value), options: Array.from(el.options as any[]).slice(0, 300).map((o) => ({ value: String(o.value), text: String(o.text).trim().slice(0, 120) })) };
}

async function shot(s: Live): Promise<string> {
  const data = await s.page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' });
  return typeof data === 'string' ? data : Buffer.from(data).toString('base64');
}

const IDLE: SessionView = {
  active: false, state: 'idle', applicationId: null, company: '', title: '', log: [], captcha: false, filled: 0, unanswered: [],
  pageUrl: '', width: VIEWPORT.width, height: VIEWPORT.height, image: '', windowVisible: false,
};

/** What the page shows. Takes a fresh picture while the browser is open. */
export async function view(opts: { image?: boolean } = {}): Promise<SessionView> {
  const s = live;
  if (!s) return IDLE;
  const open = !!s.page && !s.stopped && isActive();
  if (open && opts.image !== false) {
    try {
      s.lastImage = await shot(s);
      if (s.state === 'review') s.captcha = await hasCaptcha(s.page).catch(() => s.captcha);
    } catch {
      /* page is navigating; keep the last picture */
    }
  }
  let pageUrl = '';
  try {
    pageUrl = open ? String(s.page.url()) : '';
  } catch {
    pageUrl = '';
  }
  return {
    active: isActive(), state: s.state, applicationId: s.applicationId, company: s.company, title: s.title, log: s.log.slice(-30), captcha: s.captcha,
    filled: s.filled, unanswered: s.unanswered, pageUrl, width: s.viewport.width, height: s.viewport.height, image: opts.image === false ? '' : s.lastImage, windowVisible: s.visible,
  };
}

/** Relay one click, keystroke or scroll from the person to the form. */
export async function input(ev: SessionInput): Promise<InputResult> {
  const s = live;
  if (!s || !s.page || s.stopped || s.state !== 'review') throw new Error('The form is not ready for input yet.');
  const inside = (x: number, y: number) => x >= 0 && x <= s.viewport.width && y >= 0 && y <= s.viewport.height;
  if (ev.type === 'click') {
    if (!inside(ev.x, ev.y)) throw new Error('That click is outside the page.');
    const x = Math.round(ev.x);
    const y = Math.round(ev.y);
    const select = await s.page.evaluate(selectAtPoint, { x, y }).catch(() => null);
    if (select) return { select: { x, y, ...select } };
    await s.page.mouse.click(x, y);
  } else if (ev.type === 'select') {
    if (!inside(ev.x, ev.y) || typeof ev.value !== 'string' || ev.value.length > 300) throw new Error('That choice is not on the page.');
    const done = await s.page.evaluate(selectAtPoint, { x: Math.round(ev.x), y: Math.round(ev.y), value: ev.value });
    if (!done) throw new Error('That dropdown moved. Tap it again.');
  } else if (ev.type === 'type') {
    if (typeof ev.text !== 'string' || !ev.text || ev.text.length > 2000) throw new Error('Nothing to type.');
    await s.page.keyboard.type(ev.text);
  } else if (ev.type === 'key') {
    if (!KEYS.includes(ev.key)) throw new Error('That key is not supported.');
    await s.page.keyboard.press(ev.key);
  } else if (ev.type === 'scroll') {
    const dy = Math.max(-2000, Math.min(2000, Math.round(Number(ev.dy) || 0)));
    await s.page.evaluate((y: number) => (globalThis as any).scrollBy(0, y), dy);
  } else if (ev.type === 'viewport') {
    s.viewport = ev.narrow ? NARROW : VIEWPORT;
    await resize(s);
  } else {
    throw new Error('Unknown input.');
  }
  return {};
}

/** Press the form's own Submit button. Only ever called by the person. */
export async function submit(): Promise<string> {
  const s = live;
  if (!s || !s.page || s.stopped || s.state !== 'review') throw new Error('There is no form waiting for Submit.');
  const clicked = await s.page.evaluate(() => {
    const d = (globalThis as any).document;
    const buttons = Array.from(d.querySelectorAll('button, input[type=submit]')) as any[];
    const b = buttons.find((x) => /submit( application)?|apply/i.test(x.value || x.innerText || ''));
    if (!b) return 'none';
    const invalid = !!d.querySelector('form:invalid');
    b.scrollIntoView({ block: 'center' });
    b.click();
    return invalid ? 'invalid' : 'ok';
  });
  if (clicked === 'none') throw new Error('Could not find a Submit button. Click it in the picture.');
  if (clicked === 'invalid') {
    say(s, 'The form says a required field is still empty. Fill it in the picture, then submit again.');
    return 'A required field is still empty.';
  }
  say(s, 'Submit pressed. Waiting for the confirmation page.');
  return 'Submit pressed.';
}

export async function stop(): Promise<void> {
  const s = live;
  if (!s) return;
  if (isActive()) {
    s.state = 'ended';
    say(s, 'Stopped.');
  }
  await close(s);
}

/** Test hook. */
export async function reset() {
  if (live) await close(live);
  live = null;
}
