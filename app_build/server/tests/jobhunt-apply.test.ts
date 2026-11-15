'use strict';

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUrl, assistedApply, checkCaps, detectAts, loadBank, planFill, profileFrom, recordRun, saveAnswer, type FormField } from '../jobhunt/apply';
import { createJobHunt } from '../jobhunt/index';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', email: 'sam@example.com', phone: '555-0100', location: { city: 'Dayton', region: 'OH' }, profiles: [{ network: 'LinkedIn', url: 'https://www.linkedin.com/in/samrivera' }] },
  work: [{ name: 'Northwind', position: 'QA Engineer', startDate: '2021-01', highlights: ['Built a Playwright suite'] }],
};

const field = (label: string, kind: FormField['kind'] = 'text', extra: Partial<FormField> = {}): FormField => ({ id: label, label, kind, required: false, options: [], filled: false, ...extra });

describe('assisted apply planning', () => {
  test('ATS detection and apply URLs', () => {
    expect(detectAts('https://job-boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(applyUrl('https://jobs.lever.co/acme/abc')).toBe('https://jobs.lever.co/acme/abc/apply');
    expect(applyUrl('https://jobs.ashbyhq.com/acme/abc')).toBe('https://jobs.ashbyhq.com/acme/abc/application');
  });

  test('profile fields fill, sensitive questions only from the bank, nothing guessed', () => {
    const profile = profileFrom(MASTER);
    const fields = [
      field('First Name *'), field('Last Name *'), field('Email *'), field('LinkedIn Profile'), field('Current Company'),
      field('Are you legally authorized to work in the US? *', 'radio', { options: ['Yes', 'No'], required: true }),
      field('Gender', 'select', { options: ['Male', 'Female', 'Decline to self identify'] }),
      field('Resume/CV *', 'file', { required: true }), field('Cover Letter', 'file'),
      field('How did you hear about us?', 'select', { options: ['LinkedIn', 'Referral'] }),
    ];
    const plan = planFill(fields, profile, [{ question: 'How did you hear about us', answer: 'linkedin' }], { resume: '/r.pdf', coverLetter: '/c.txt' });
    const got = Object.fromEntries(plan.actions.map((a) => [a.field.label, a.value]));
    expect(got).toEqual({
      'First Name *': 'Sam', 'Last Name *': 'Rivera', 'Email *': 'sam@example.com', 'LinkedIn Profile': 'https://www.linkedin.com/in/samrivera',
      'Current Company': 'Northwind', 'Resume/CV *': '/r.pdf', 'Cover Letter': '/c.txt', 'How did you hear about us?': 'LinkedIn',
    });
    expect(plan.unanswered.map((f) => f.label)).toEqual(['Are you legally authorized to work in the US? *', 'Gender']);
    const withBank = planFill(fields, profile, [{ question: 'Are you legally authorized to work in the US?', answer: 'Yes' }], { resume: null, coverLetter: null });
    expect(withBank.actions.find((a) => a.field.label.startsWith('Are you'))?.value).toBe('Yes');
  });

  test('caps: daily limit, per company, site failures', () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const mk = (company: string) => {
      const job = store.upsertJob({ company, title: `QA ${Math.random()}`, descriptionText: 'x', url: 'https://boards.greenhouse.io/acme/jobs/1' });
      return store.createApplication(job.id);
    };
    const target = () => store.listApplications().find((a) => a.status === 'saved')!;
    mk('Acme');
    expect(checkCaps(store, target())).toBeNull();
    for (let i = 0; i < 3; i++) recordRun(store, 'greenhouse', false);
    expect(checkCaps(store, target())).toMatch(/paused/);
    recordRun(store, 'greenhouse', true);
    expect(checkCaps(store, target(), { dailyLimit: 1 })).toMatch(/Daily limit/);
    expect(checkCaps(store, target(), { dailyLimit: 5 })).toBeNull();
    store.close();
  });

  test('answer bank saves, dedupes by question', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jh-')), 'answers.json');
    saveAnswer(path, 'Do you need sponsorship? *', 'No');
    saveAnswer(path, 'do you need sponsorship', 'No, never');
    expect(loadBank(path)).toEqual([{ question: 'do you need sponsorship', answer: 'No, never' }]);
  });
});

let chromium: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  chromium = require('playwright').chromium;
} catch { /* not installed in CI */ }
const browserTest = chromium ? test : test.skip;

describe('assisted apply in a real browser', () => {
  browserTest('fills the form, stops before Submit, texts questions, then sees the confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-apply-'));
    const docs = join(dir, 'documents');
    const sent: string[] = [];
    const store = new JobHuntStore({ path: ':memory:' });
    const jh = createJobHunt({
      store, sms: { send: async (b) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } },
      mail: null, smsInbox: null, generate: null, pdf: null, outputDir: docs, masterResume: MASTER, answersPath: join(dir, 'answers.json'),
      preferences: {},
    });
    const url = `file://${join(__dirname, 'fixtures', 'jobhunt-apply-form.html')}`;
    const { application } = await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: 'Playwright testing.', url });
    await jh.tailor(application.id, { force: true });
    // No PDF renderer in this test: stand in a resume file.
    const appDir = require('node:fs').readdirSync(docs)[0];
    writeFileSync(join(docs, appDir, 'resume.pdf'), '%PDF-1.4 test');
    writeFileSync(join(dir, 'answers.json'), JSON.stringify([{ question: 'How did you hear about this job?', answer: 'Company website' }]));

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const r = await jh.applyWith(page, application.id);
      expect(r.filled).toBe(8); // first, last, email, phone, resume, cover letter, linkedin, how did you hear
      expect(r.unanswered.map((u) => u.label)).toEqual(['Will you now or in the future require visa sponsorship? *', 'Why do you want to work here?']);
      expect(r.captcha).toBe(false);
      expect(r.submitted).toBe(false);
      expect(r.confirmed).toBe(false);
      expect(existsSync(join(docs, appDir, 'apply-screenshot.png'))).toBe(true);
      expect(await page.inputValue('#first_name')).toBe('Sam');
      expect(await page.inputValue('#q2')).toBe('1');
      expect(await page.evaluate(() => (globalThis as any).document.querySelector('#resume').files.length)).toBe(1);
      expect(sent[sent.length - 1]).toMatch(/Ready for review: Acme.*Needs answers: 1\) Will you.* 2\) Why do you want to work here\? \(optional\).*Reply ANSWER .* 1 your answer.*click Submit/);

      // Text reply answers question 2; it lands in the bank for next time.
      const code = application.id.slice(0, 4);
      expect(await jh.handleReply(`ANSWER ${code} 1 No`)).toMatch(/Saved/);
      expect(loadBank(jh.answersPath).some((a) => /sponsorship/.test(a.question) && a.answer === 'No')).toBe(true);

      // The person clicks Submit; a rerun with a wait sees the confirmation and marks applied.
      await page.click('button[type=submit]');
      const { isConfirmed } = require('../jobhunt/apply');
      expect(await isConfirmed(page)).toBe(true);
      await store.setStatus(application.id, 'applied', { source: 'system', reason: 'confirmation page seen' });
      expect(jh.list()[0].status).toBe('applied');
    } finally {
      await browser.close();
      jh.close();
    }
  }, 60_000);
});
