'use strict';

import { loadDrafts } from '../jobhunt/responses';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover } from '../jobhunt/discovery';
import { interviewTimeFromEmail, parseIcs, parseTextTime, runFollowups, zonedToUtc } from '../jobhunt/followups';
import { createJobHunt } from '../jobhunt/index';
import { learnedBoost, salaryIntel, skillsGap, titleFamily, whatWorks } from '../jobhunt/insights';
import { buildPrepPack } from '../jobhunt/prep';
import { companyKey, matchReferrals, parseConnections, referralAsk } from '../jobhunt/referrals';
import type { SmsSender } from '../jobhunt/sms';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', email: 'sam@example.com', label: 'QA Engineer' },
  work: [{ name: 'Northwind', position: 'QA Automation Engineer', startDate: '2020-01', highlights: [
    'Built a Cypress and Playwright suite with 600+ tests in GitHub Actions',
    'Validated 50+ REST API endpoints with Postman and SQL',
  ] }],
  skills: [{ name: 'Testing', keywords: ['Cypress', 'Playwright', 'Postman', 'SQL', 'API', 'GitHub Actions'] }],
};

const POSTING = (extra = '') => `Requirements:\n- 3+ years with Playwright or Cypress\n- REST API testing with Postman\n- Experience with Kubernetes\n- Experience with JMeter performance testing\n${extra}`;

function fakeSms(): SmsSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: async (b) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } };
}

describe('insights', () => {
  test('skills gap counts what postings ask for and the resume lacks', () => {
    const store = new JobHuntStore({ path: ':memory:' });
    for (let i = 0; i < 3; i++) store.upsertJob({ company: `C${i}`, title: 'QA Engineer', descriptionText: POSTING(i ? '' : '- Terraform') });
    const gap = skillsGap(store, MASTER);
    expect(gap.total).toBe(3);
    const terms = gap.rows.map((r) => r.term);
    expect(terms).toContain('kubernetes');
    expect(terms).toContain('jmeter');
    expect(terms).not.toContain('playwright');
    expect(terms).not.toContain('terraform'); // only in 1 posting, below minPostings
    expect(gap.rows.find((r) => r.term === 'kubernetes')).toMatchObject({ postings: 3, share: 100, asMust: 3 });
  });

  test('salary intel uses only stated ranges', () => {
    const store = new JobHuntStore({ path: ':memory:' });
    store.upsertJob({ company: 'A', title: 'QA Engineer', location: 'Remote', descriptionText: 'Remote. Pay: $80,000 - $100,000' });
    store.upsertJob({ company: 'B', title: 'Senior QA Engineer', descriptionText: 'Pay $120k-$140k' });
    store.upsertJob({ company: 'C', title: 'QA Engineer', descriptionText: 'No pay listed' });
    const s = salaryIntel(store);
    expect(s.withPay).toBe(2);
    expect(s.rows[0]).toMatchObject({ group: 'All', n: 2, medianMin: 100000, medianMax: 120000 });
    expect(s.top[0]).toEqual({ company: 'B', title: 'Senior QA Engineer', max: 140000 });
  });

  test('what works and learned boost stay off until there is real history', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    expect(titleFamily('SDET II')).toBe('SDET');
    expect(titleFamily('QA Analyst')).toBe('QA analyst');
    const mk = async (title: string, source: 'lever' | 'adzuna', good: boolean) => {
      const job = store.upsertJob({ company: `Co ${Math.random()}`, title, descriptionText: 'x', source, sourceId: String(Math.random()) });
      const app = store.createApplication(job.id);
      await store.setStatus(app.id, 'tailored');
      await store.setStatus(app.id, 'applied');
      if (good) await store.setStatus(app.id, 'screening');
      return job;
    };
    for (let i = 0; i < 20; i++) await mk('QA Engineer', 'lever', i < 10);
    for (let i = 0; i < 20; i++) await mk('QA Engineer', 'adzuna', i < 2);
    const w = whatWorks(store);
    expect(w.sent).toBe(40);
    expect(w.rows.find((r) => r.dimension === 'Source' && r.group === 'lever')?.rate).toBe(50);
    const lever = store.allJobs().find((j) => j.source === 'lever')!;
    const adz = store.allJobs().find((j) => j.source === 'adzuna')!;
    expect(learnedBoost(store, lever).delta).toBeGreaterThan(0);
    expect(learnedBoost(store, adz).delta).toBeLessThan(0);
    expect(learnedBoost(store, lever, { minSent: 100 }).delta).toBe(0);
  });
});

describe('interview prep pack', () => {
  test('uses verbatim resume bullets and lists what is not covered', () => {
    const job = { id: 'j', source: 'manual' as const, sourceId: null, url: 'https://example.com/j', company: 'Acme', title: 'QA Engineer', location: 'Remote', descriptionText: POSTING(), createdAt: 0 };
    const pack = buildPrepPack(MASTER, job);
    expect(pack.covered.some((c) => c.proof.some((p) => p.text === MASTER.work![0].highlights![0]))).toBe(true);
    expect(pack.uncovered.join(' ')).toMatch(/Kubernetes/);
    expect(pack.markdown).toMatch(/flaky/);
    expect(pack.markdown).toMatch(/load test/);
    expect(pack.html).not.toMatch(/—/);
    expect(pack.markdown).not.toMatch(/—/);
  });
});

describe('referrals', () => {
  const CSV = [
    'Notes:',
    '"When exporting your connection data, you may notice..."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Jane,Doe,https://www.linkedin.com/in/janedoe,,Acme Inc.,QA Lead,01 Jan 2024',
    'Bob,Lee,https://www.linkedin.com/in/boblee,bob@x.com,"Acme, Inc",Recruiter,02 Feb 2024',
    'Ann,Kim,https://www.linkedin.com/in/annkim,,Acmeworks,Engineer,03 Mar 2024',
  ].join('\n');

  test('parses the LinkedIn export and matches by company', () => {
    const people = parseConnections(CSV);
    expect(people).toHaveLength(3);
    expect(companyKey('Acme Inc.')).toBe('acme');
    const hits = matchReferrals(people, 'ACME');
    expect(hits.map((p) => p.firstName)).toEqual(['Jane', 'Bob']);
    const job = { id: 'j', source: 'manual' as const, sourceId: null, url: null, company: 'Acme', title: 'QA Engineer', location: null, descriptionText: '', createdAt: 0 };
    expect(referralAsk(hits[0], job, MASTER)).toMatch(/^Hi Jane,[\s\S]*Sam$/);
  });

  test('addPosting texts known connections and saves a referral ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-ref-'));
    writeFileSync(join(dir, 'connections.csv'), CSV);
    const sms = fakeSms();
    const jh = createJobHunt({ store: new JobHuntStore({ path: ':memory:' }), sms, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: {}, connectionsPath: join(dir, 'connections.csv'), autoTailor: false });
    const r = await jh.addPosting({ company: 'Acme', title: 'QA Automation Engineer', descriptionText: POSTING() });
    expect(sms.sent[0]).toMatch(/You know Jane Doe, Bob Lee there/);
    expect(jh.store.contacts(r.application.id).map((c) => c.source)).toEqual(['referral', 'referral']);
    const folder = readdirSync(join(dir, 'docs'))[0];
    expect(readFileSync(join(dir, 'docs', folder, 'referral-ask.txt'), 'utf8')).toMatch(/Hi Jane,/);
    jh.close();
  });
});

describe('interview times and follow-through', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  test('ICS with TZID and UTC', () => {
    const ics = 'BEGIN:VEVENT\r\nDTSTART;TZID=America/New_York:20261118T140000\r\nDTEND;TZID=America/New_York:20261118T144500\r\nLOCATION:https://zoom.us/j/1\r\nEND:VEVENT';
    const t = parseIcs(ics)!;
    expect(new Date(t.start).toISOString()).toBe('2026-11-18T19:00:00.000Z');
    expect((t.end - t.start) / 60000).toBe(45);
    expect(t.location).toBe('https://zoom.us/j/1');
    expect(new Date(parseIcs('DTSTART:20261118T190000Z')!.start).toISOString()).toBe('2026-11-18T19:00:00.000Z');
  });

  test('prose times: one confirmed time parses, a list of options does not', () => {
    const one = parseTextTime('Confirmed for Tuesday, November 18 at 2:00 PM ET for 45 minutes. https://meet.google.com/abc-defg-hij', now)!;
    expect(new Date(one.start).toISOString()).toBe('2026-11-18T19:00:00.000Z');
    expect((one.end - one.start) / 60000).toBe(45);
    expect(one.location).toBe('https://meet.google.com/abc-defg-hij');
    expect(new Date(parseTextTime('See you 11/18 at 11am PT', now)!.start).toISOString()).toBe('2026-11-18T19:00:00.000Z');
    expect(parseTextTime('Are you free Nov 18 at 2pm or Nov 19 at 3pm?', now)).toBeNull();
    expect(zonedToUtc(2026, 7, 1, 12, 0, 'America/New_York')).toBe(Date.parse('2026-07-01T16:00:00Z'));
  });

  test('email with an invite: calendar event, reminder, thank-you draft, follow-up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-fu-'));
    const sms = fakeSms();
    const events: any[] = [];
    const drafts: any[] = [];
    const mail: any = {
      search: async () => [], getRaw: async () => '', ownAddresses: () => [],
      createDraft: async (d: any) => { drafts.push(d); return 'd1'; },
      calendar: { findEvents: async () => [], createEvent: async (e: any) => { events.push(e); return 'e1'; } },
    };
    let clock = now;
    const store = new JobHuntStore({ path: ':memory:', now: () => clock });
    const jh = createJobHunt({ store, sms, mail, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: {} });
    const { application } = await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: POSTING() });
    store.upsertContact({ applicationId: application.id, name: 'Dana Lee', email: 'dana@acme.com', source: 'email' });
    await store.setStatus(application.id, 'tailored', { force: true } as any).catch(() => undefined);
    await store.setStatus(application.id, 'applied');
    await new Promise((r) => setTimeout(r, 0));
    // Drafts wait in the app's reply queue. Nothing goes to the mailbox on its own.
    expect(drafts).toEqual([]);
    expect(loadDrafts(store)[0]).toMatchObject({ kind: 'outreach', to: 'dana@acme.com', subject: 'QA Engineer application', status: 'pending' });
    expect(loadDrafts(store)[0].body).toMatch(/^Hi Dana,/);

    await store.setStatus(application.id, 'interviewing');
    await new Promise((r) => setTimeout(r, 0));
    expect(sms.sent.some((s) => /Interview prep pack ready/.test(s))).toBe(true);

    const raw = ['From: Dana <dana@acme.com>', 'Subject: Interview confirmed', 'Content-Type: text/plain', '', 'Confirmed for Wednesday, November 18 at 2:00 PM ET.'].join('\r\n');
    const when = interviewTimeFromEmail(raw, now)!;
    await jh.recordInterview(application.id, when);
    expect(events[0].summary).toBe('Interview: Acme, QA Engineer');
    expect(sms.sent[sms.sent.length - 1]).toMatch(/Interview with Acme: Wed, Nov 18, 2:00 PM ET, added to Google Calendar/);

    const deps = { store, sms, mail, master: () => MASTER, outputDir: join(dir, 'docs') };
    expect(await runFollowups({ ...deps, now: () => when.start - 60 * 60_000 })).toEqual([`reminder ${application.id.slice(0, 8)}`]);
    expect(await runFollowups({ ...deps, now: () => when.start - 59 * 60_000 })).toEqual([]);
    expect(await runFollowups({ ...deps, now: () => when.end + 60_000 })).toEqual([`thank-you ${application.id.slice(0, 8)}`]);
    const thanks = loadDrafts(store).find((d) => d.kind === 'thankyou')!;
    expect(thanks.subject).toBe('Thank you: QA Engineer');
    expect(thanks.dueAt).toBe(when.end + 2 * 3_600_000); // the rule waits 2 hours after the interview
    expect(drafts).toEqual([]);
    jh.close();
  });

  test('7-day follow-up is drafted once into the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-fu2-'));
    const sms = fakeSms();
    let clock = now;
    const store = new JobHuntStore({ path: ':memory:', now: () => clock });
    const jh = createJobHunt({ store, sms, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: {}, autoTailor: false });
    const { application } = await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: POSTING() });
    await store.setStatus(application.id, 'tailored');
    await store.setStatus(application.id, 'applied');
    const deps = { store, sms, mail: null, master: () => MASTER, outputDir: join(dir, 'docs'), prefs: () => ({ responses: { followup: { weekdaysOnly: false } } }) };
    expect(await runFollowups({ ...deps, now: () => now + 6 * 86_400_000 })).toEqual([]);
    expect(await runFollowups({ ...deps, now: () => now + 7 * 86_400_000 })).toEqual([`follow-up ${application.id.slice(0, 8)}`]);
    expect(await runFollowups({ ...deps, now: () => now + 8 * 86_400_000 })).toEqual([]);
    expect(loadDrafts(store).filter((d) => d.kind === 'followup').map((d) => d.subject)).toEqual(['Following up: QA Engineer']);
    expect(sms.sent[sms.sent.length - 1]).toMatch(/Follow-up drafted for Acme\. Open Replies to review it\. Nothing is sent until you press Send\./);
    jh.close();
  });
});

describe('top matches', () => {
  test('hot postings may exceed the daily target, a few per day', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const jobs = Array.from({ length: 6 }, (_, i) => ({ id: i, title: `QA Automation Engineer ${i}`, location: { name: 'Remote' }, content: POSTING(), absolute_url: `https://x/${i}` }));
    const fetchImpl: any = async () => ({ ok: true, json: async () => ({ jobs }) });
    const prefs = { watchlist: [{ ats: 'greenhouse' as const, slug: 'acme', name: 'Acme' }], dailyTarget: 1, hotScore: 0, hotExtra: 2 };
    const r = await discover(store, MASTER, prefs, { fetchImpl, now: Date.parse("2026-11-14T12:00:00Z") });
    expect(r.admitted).toHaveLength(3); // 1 target + 2 hot extras
  });
});
