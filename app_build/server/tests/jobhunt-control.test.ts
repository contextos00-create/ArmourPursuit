'use strict';

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as session from '../jobhunt/apply-session';
import { createJobHunt } from '../jobhunt/index';
import * as remote from '../jobhunt/remote';
import { runDue } from '../jobhunt/scheduler';
import { DEFAULT_SETTINGS, mergeSettings, toSettings } from '../jobhunt/settings';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', email: 'sam@example.com', phone: '555-0100', location: { city: 'Dayton', region: 'OH' } },
  work: [{ name: 'Northwind', position: 'QA Engineer', startDate: '2021-01', highlights: ['Built a Playwright suite'] }],
};

function setup(preferences: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-ctl-'));
  const sent: string[] = [];
  const jh = createJobHunt({
    store: new JobHuntStore({ path: ':memory:' }), sms: { send: async (b) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } },
    mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'documents'), masterResume: MASTER, answersPath: join(dir, 'answers.json'), preferences, autoTailor: false,
  });
  return { dir, jh, sent };
}

describe('settings', () => {
  test('defaults when nothing is saved', () => {
    expect(toSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(toSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  test('merge validates, clamps, keeps unknown keys and drops empty lists', () => {
    const saved = { yearsExperience: 6, titleKeywords: ['qa'], adzuna: { country: 'us', what: ['qa engineer'] } };
    const next = mergeSettings(saved, {
      ...DEFAULT_SETTINGS, titleKeywords: [], targetTitles: [' QA Engineer ', 'QA Engineer', 7], workModes: ['remote', 'moon'], seniority: 'wizard',
      dailyTarget: 9999, autoTailorAt: 70, approvalAt: 90, salaryFloor: 65000, usOnly: true, autoSubmit: 'yes',
      watchlist: [{ ats: 'lever', slug: 'acme', name: 'Acme' }, { ats: 'workday', slug: 'x' }, { ats: 'ashby', slug: '../etc' }],
      adzunaWhat: ['sdet'], adzunaWhere: ['Cincinnati'], activeStart: 9, activeEnd: 5, applyWindow: 'hidden', agentInstructions: '  Prefer remote.  ', evil: { nested: true },
    });
    expect(next.yearsExperience).toBe(6);
    expect(next.titleKeywords).toBeUndefined();
    expect(next.targetTitles).toEqual(['QA Engineer']);
    expect(next.workModes).toEqual(['remote']);
    expect(next.seniority).toBeUndefined();
    expect(next.dailyTarget).toBe(50);
    expect(next.approvalAt).toBe(70);
    expect(next.country).toBe('US');
    expect(next.autoSubmit).toBe(false);
    expect(next.watchlist).toEqual([{ ats: 'lever', slug: 'acme', name: 'Acme' }]);
    expect(next.adzuna).toEqual({ country: 'us', what: ['sdet'], where: ['Cincinnati'], maxDaysOld: 7 });
    expect(next.schedule.activeHours).toEqual([9, 10]);
    expect(next.apply.window).toBe('hidden');
    expect(next.agentInstructions).toBe('Prefer remote.');
    expect(next.evil).toBeUndefined();
    const round = toSettings(next);
    expect(round.salaryFloor).toBe(65000);
    expect(round.watchlist).toEqual([{ ats: 'lever', slug: 'acme', name: 'Acme' }]);
  });

  test('the scheduler follows saved active hours', async () => {
    const { jh } = setup({ schedule: { activeHours: [9, 10] } });
    let discovered = 0;
    (jh as any).discover = async () => { discovered++; return { fetched: 0, fresh: 0, added: [], deferred: 0, filteredOut: 0, errors: [] }; };
    await runDue(jh, { now: () => new Date(2026, 10, 16, 12, 0), log: () => {} });
    expect(discovered).toBe(0);
    await runDue(jh, { now: () => new Date(2026, 10, 16, 9, 30), log: () => {} });
    expect(discovered).toBe(1);
    jh.close();
  });
});

describe('phone access', () => {
  test('off by default, passcode login, hashed storage, lockout', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jh-remote-')), 'remote.json');
    remote.resetThrottle();
    expect(remote.remoteStatus(path)).toEqual({ enabled: false, devices: 0 });
    expect(() => remote.login(path, 'whatever')).toThrow(/turned off/);
    expect(() => remote.setPasscode(path, 'short')).toThrow(/8 characters/);
    remote.setPasscode(path, 'correct horse battery');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('correct horse');
    const { token } = remote.login(path, 'correct horse battery', 'phone');
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    expect(remote.validSession(path, token)).toBe(true);
    expect(remote.validSession(path, 'f'.repeat(64))).toBe(false);
    expect(remote.validSession(path, token, Date.now() + 31 * 86_400_000)).toBe(false);
    expect(remote.remoteStatus(path).devices).toBe(1);
    for (let i = 0; i < 5; i++) expect(() => remote.login(path, 'wrong passcode')).toThrow(/Wrong/);
    expect(() => remote.login(path, 'correct horse battery')).toThrow(/Too many/);
    remote.resetThrottle();
    remote.setPasscode(path, 'a new long passcode');
    expect(remote.validSession(path, token)).toBe(false);
    remote.disableRemote(path);
    expect(remote.remoteStatus(path).enabled).toBe(false);
  });
});

let chromium: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  chromium = require('playwright').chromium;
} catch { /* not installed in CI */ }
const browserTest = chromium ? test : test.skip;
const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
};

describe('live apply session', () => {
  test('window mode', () => {
    expect(session.wantVisible('hidden', { DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(session.wantVisible('auto', {}, 'linux')).toBe(false);
    expect(session.wantVisible('visible', {}, 'linux')).toBe(false);
    expect(session.wantVisible('auto', {}, 'darwin')).toBe(true);
  });

  browserTest('fills, shows a picture, relays the person’s typing and Submit, then marks applied', async () => {
    const { dir, jh } = setup();
    const url = `file://${join(__dirname, 'fixtures', 'jobhunt-apply-form.html')}`;
    const { application } = await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: 'Playwright testing.', url });
    await jh.tailor(application.id, { force: true });
    writeFileSync(join(dir, 'documents', readdirSync(join(dir, 'documents'))[0], 'resume.pdf'), '%PDF-1.4 test');
    writeFileSync(join(dir, 'answers.json'), JSON.stringify([{ question: 'Will you now or in the future require visa sponsorship?', answer: 'No' }]));
    let page: any;
    const launch: session.Launch = async () => {
      const browser = await chromium.launch();
      page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      return { browser, page };
    };
    try {
      await expect(session.input({ type: 'key', key: 'Enter' })).rejects.toThrow(/not ready/);
      expect(await session.start(jh, application.id, { launch, waitMinutes: 1 })).toMatch(/Started Acme/);
      await expect(session.start(jh, application.id, { launch })).rejects.toThrow(/Already working/);
      await until(async () => (await session.view({ image: false })).state === 'review');
      const v = await session.view();
      expect(v.active).toBe(true);
      expect(v.filled).toBe(7); // first, last, email, phone, resume, cover letter, sponsorship
      expect(v.unanswered.length).toBeGreaterThan(0);
      expect(Buffer.from(v.image, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG
      expect(v.log.map((l) => l.text).join(' ')).toMatch(/Filled 7 fields.*left for you.*press Submit application/);

      // The person clicks a field in the picture and types into it.
      const box = await page.locator('textarea').first().boundingBox();
      await session.input({ type: 'scroll', dy: 0 });
      const y = await page.evaluate(() => (globalThis as any).scrollY);
      await session.input({ type: 'click', x: box.x + 10, y: box.y - y + 10 });
      await session.input({ type: 'type', text: 'I like testing.' });
      expect(await page.locator('textarea').first().inputValue()).toBe('I like testing.');
      await expect(session.input({ type: 'key', key: 'F12' })).rejects.toThrow(/not supported/);
      await expect(session.input({ type: 'click', x: 5000, y: 1 })).rejects.toThrow(/outside/);

      // A required dropdown is still empty: the form refuses, and the run says so.
      expect(await session.submit()).toMatch(/required field/);
      const select = await page.locator('select').first().boundingBox();
      // A native dropdown's popup cannot be shown in the picture, so a click on it returns its options instead.
      const picked = await session.input({ type: 'click', x: select.x + 10, y: select.y - y + 10 });
      expect(picked.select?.options.map((o) => o.text)).toEqual(['Select...', 'Company website', 'LinkedIn', 'Referral']);
      await expect(session.input({ type: 'select', x: 5, y: 5, value: '2' })).rejects.toThrow(/moved/);
      await session.input({ type: 'select', x: picked.select!.x, y: picked.select!.y, value: '2' });
      expect(await page.locator('select').first().inputValue()).toBe('2');
      // Phone layout and back.
      await session.input({ type: 'viewport', narrow: true });
      expect((await session.view({ image: false })).width).toBe(430);
      expect(page.viewportSize().width).toBe(430);
      await session.input({ type: 'viewport', narrow: false });
      expect(await session.submit()).toMatch(/Submit pressed/);
      await until(async () => (await session.view({ image: false })).state === 'applied');
      expect(jh.list()[0].status).toBe('applied');
      expect((await session.view()).active).toBe(false);
    } finally {
      await session.reset();
      jh.close();
    }
  }, 60_000);

  browserTest('stop ends the run without marking applied', async () => {
    const { dir, jh } = setup();
    const url = `file://${join(__dirname, 'fixtures', 'jobhunt-apply-form.html')}`;
    const { application } = await jh.addPosting({ company: 'Globex', title: 'QA Engineer', descriptionText: 'Playwright testing.', url });
    await jh.tailor(application.id, { force: true });
    writeFileSync(join(dir, 'documents', readdirSync(join(dir, 'documents'))[0], 'resume.pdf'), '%PDF-1.4 test');
    const launch: session.Launch = async () => {
      const browser = await chromium.launch();
      return { browser, page: await browser.newPage() };
    };
    try {
      await session.start(jh, application.id, { launch, waitMinutes: 5 });
      await until(async () => (await session.view({ image: false })).state === 'review');
      await session.stop();
      const v = await session.view();
      expect(v.active).toBe(false);
      expect(v.state).toBe('ended');
      expect(jh.list()[0].status).not.toBe('applied');
      await expect(session.submit()).rejects.toThrow(/no form/i);
    } finally {
      await session.reset();
      jh.close();
    }
  }, 60_000);
});

describe('notification rules', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { gateSms, inQuietHours, notifySettings } = require('../jobhunt/notify') as typeof import('../jobhunt/notify');

  test('defaults are on, texting on, no quiet hours', () => {
    expect(notifySettings({})).toMatchObject({ enabled: true, sms: true, browser: false, off: [], quiet: false, quietUrgent: true });
    expect(notifySettings({ notifications: { off: ['digest', 'nonsense'], quietStart: 99 } })).toMatchObject({ off: ['digest'], quietStart: 21 });
  });

  test('quiet hours wrap past midnight', () => {
    const q = { quiet: true, quietStart: 21, quietEnd: 8 };
    expect(inQuietHours(q, new Date(2026, 10, 14, 23, 0))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 10, 14, 7, 59))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 10, 14, 8, 0))).toBe(false);
    expect(inQuietHours({ ...q, quiet: false }, new Date(2026, 10, 14, 23, 0))).toBe(false);
    expect(inQuietHours({ quiet: true, quietStart: 12, quietEnd: 14 }, new Date(2026, 10, 14, 13, 0))).toBe(true);
  });

  test('turned-off kinds are muted, texting off keeps them in the app, replies always go', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const sent: string[] = [];
    let prefs: any = { notifications: { off: ['digest'] } };
    const gate = gateSms({ send: async (b: string) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } }, { store, prefs: () => prefs });
    expect((await gate.send('summary', 'digest')).status).toBe('muted');
    expect((await gate.send('top', 'top_match')).status).toBe('sent');
    prefs = { notifications: { sms: false } };
    expect((await gate.send('status', 'status_major')).status).toBe('app');
    prefs = { notifications: { enabled: false } };
    expect((await gate.send('status', 'status_major')).status).toBe('muted');
    expect((await gate.send('answer', 'reply')).status).toBe('sent');
    expect(sent).toEqual(['top', 'answer']);
    store.close();
  });

  test('quiet hours hold texts, let urgent ones through, and send a capped catch-up afterward', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const sent: string[] = [];
    let clock = new Date(2026, 10, 14, 23, 0).getTime();
    const prefs = { notifications: { quiet: true, quietStart: 21, quietEnd: 8 } };
    const gate = gateSms({ send: async (b: string) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } }, { store, prefs: () => prefs, now: () => clock });
    for (const n of [1, 2, 3, 4, 5]) expect((await gate.send(`update ${n}`, 'status_minor')).status).toBe('held');
    expect((await gate.send('interview in an hour', 'interview')).status).toBe('sent');
    expect(gate.held()).toBe(5);
    expect(await gate.flush()).toBe(0); // still quiet
    clock = new Date(2026, 10, 15, 8, 5).getTime();
    expect(await gate.flush()).toBe(4);
    expect(sent).toEqual(['interview in an hour', 'update 1', 'update 2', 'update 3', '[Job] 2 more updates came in during quiet hours. Open the app to see them.']);
    expect(gate.held()).toBe(0);
    expect(store.recentNotifications().length).toBe(4);
    store.close();
  });

  test('the pipeline tags its texts, so a muted kind never reaches the phone', async () => {
    const { jh, sent } = setup({ notifications: { off: ['top_match', 'new_posting', 'status_minor'] } });
    const { application } = await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: 'Playwright' });
    expect(sent).toEqual([]);
    await jh.setStatus(application.id, 'applied');
    await jh.setStatus(application.id, 'screening');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/applied to screening/);
    expect(sent[1]).toMatch(/prep pack ready/);
    expect(jh.store.recentNotifications().map((n) => n.status)).toEqual(['sent', 'sent']);
    jh.close();
  });
});

describe('first-time setup', () => {
  test('profile form saves the resume as typed and keeps what the form does not edit', () => {
    const master: any = { basics: { name: 'Sam Rivera', profiles: [{ network: 'LinkedIn', url: 'https://example.com/in/sam' }] }, work: [{ name: 'Northwind', position: 'QA Engineer', location: 'Dayton', highlights: ['Old'] }], projects: [{ name: 'Side project' }], skills: [{ name: 'Testing', keywords: ['Playwright'] }] };
    const dir = mkdtempSync(join(tmpdir(), 'jh-setup-'));
    const prefs: any = {};
    const jh = createJobHunt({ store: new JobHuntStore({ path: ':memory:' }), sms: { send: async () => ({ status: 'sent', providerId: null, error: null }) }, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'documents'), masterResume: master, answersPath: join(dir, 'answers.json'), connectionsPath: join(dir, 'c.csv'), preferences: prefs, autoTailor: false });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cc = require('../jobhunt/command-center') as typeof import('../jobhunt/command-center');
    cc.pipeline(jh);
    let s = cc.state().setup;
    expect(s.done).toBe(false);
    expect(s.checks.find((c) => c.key === 'resume')).toMatchObject({ ok: true, required: true });
    expect(s.checks.find((c) => c.key === 'search')!.ok).toBe(false);
    expect(s.profile).toMatchObject({ name: 'Sam Rivera', skills: ['Playwright'] });
    expect(() => cc.completeSetup()).toThrow(/What to look for/);
    expect(() => cc.saveProfile({ ...s.profile, name: '' })).toThrow(/name/);
    expect(() => cc.saveProfile({ ...s.profile, work: [] })).toThrow(/at least one job/);
    expect(cc.saveProfile({ ...s.profile, email: 'sam@example.com', city: 'Dayton', work: [{ name: 'Northwind', position: 'QA Engineer', startDate: '2021-01', endDate: '', highlights: ['Built a Playwright suite', '  '] }], skills: ['Playwright', 'SQL'] })).toMatch(/saved/);
    expect(master.work[0]).toMatchObject({ location: 'Dayton', highlights: ['Built a Playwright suite'] });
    expect(master.projects).toEqual([{ name: 'Side project' }]);
    expect(master.basics.profiles).toHaveLength(1);
    expect(master.skills).toEqual([{ name: 'Skills', keywords: ['Playwright', 'SQL'] }]);
    expect(() => cc.importResumeJson('not json')).toThrow(/not valid JSON/);
    expect(() => cc.importResumeJson('{"basics":{"name":"X"}}')).toThrow(/work/);
    cc.saveSettings({ ...DEFAULT_SETTINGS, targetTitles: ['QA Engineer'], notifyOff: ['digest'], quietEnabled: true, quietStart: 22, quietEnd: 7 });
    expect(cc.state().settings).toMatchObject({ notifyOff: ['digest'], quietEnabled: true, quietStart: 22, quietEnd: 7 });
    expect(cc.completeSetup()).toMatch(/finished/);
    s = cc.state().setup;
    expect(s.done).toBe(true);
    expect(cc.state().notify.categories.map((c) => c.key)).toContain('top_match');
    jh.close();
  });
});
