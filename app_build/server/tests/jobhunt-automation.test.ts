'use strict';

import { canonicalKey, discover, fetchBoard, titleAllowed } from '../jobhunt/discovery';
import { classifyEmail, decodeHeader, matchApplication, parseEmail, scanInbox } from '../jobhunt/inbox';
import { createJobHunt } from '../jobhunt/index';
import { buildDigest, sweepStale } from '../jobhunt/lifecycle';
import { handleReply, isPaused, processReplies } from '../jobhunt/replies';
import { runDue } from '../jobhunt/scheduler';
import { attachSmsNotifier, type SmsSender } from '../jobhunt/sms';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', label: 'QA Engineer', summary: 'QA engineer.' },
  work: [{ name: 'Northwind', position: 'QA Automation Engineer', startDate: '2021-01', highlights: [
    'Built a Cypress and Playwright suite with 600+ tests in GitHub Actions',
    'Validated 50+ REST API endpoints with Postman and SQL',
  ] }],
  skills: [{ name: 'Testing', keywords: ['Cypress', 'Playwright', 'Postman', 'SQL', 'API'] }],
};

function fakeSms(): SmsSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: async (body) => { sent.push(body); return { status: 'sent', providerId: null, error: null }; } };
}

function email(from: string, subject: string, body: string, extra = '') {
  return [`From: ${from}`, 'To: sam@example.com', `Subject: ${subject}`, extra, 'Content-Type: text/plain', '', body].filter((l) => l !== '').join('\r\n').replace('Content-Type: text/plain\r\n', 'Content-Type: text/plain\r\n\r\n');
}

async function seeded(status: 'applied' | 'screening' = 'applied') {
  const store = new JobHuntStore({ path: ':memory:' });
  const sms = fakeSms();
  attachSmsNotifier(store, sms);
  const job = store.upsertJob({ company: 'Acme Inc', title: 'QA Engineer', descriptionText: 'x' });
  const app = store.createApplication(job.id);
  await store.setStatus(app.id, 'applied');
  if (status === 'screening') await store.setStatus(app.id, 'screening');
  sms.sent.length = 0;
  return { store, sms, app, job };
}

describe('inbox classifier', () => {
  test('categories and precedence', () => {
    expect(classifyEmail({ subject: 'Thank you for applying to Acme', text: 'We have received your application.' }).category).toBe('confirmation');
    expect(classifyEmail({ subject: 'Your application', text: 'Thank you for applying. Unfortunately we have decided to move forward with other candidates.' }).category).toBe('rejection');
    const oa = classifyEmail({ subject: 'Next step', text: 'Please complete the HackerRank assessment: https://www.hackerrank.com/test/abc by Friday.' });
    expect(oa.category).toBe('assessment');
    expect(oa.link).toBe('https://www.hackerrank.com/test/abc');
    expect(classifyEmail({ subject: 'Interview', text: 'Pick a time here: https://calendly.com/recruiter/30min' }).category).toBe('interview');
    expect(classifyEmail({ subject: 'Hi', text: 'Unfortunately the office is closed Monday.' }).category).toBe('other');
    expect(classifyEmail({ subject: 'Your verification code', text: 'Code 123456' }).category).toBe('verification');
  });

  test('decodes encoded subjects', () => {
    expect(decodeHeader('=?UTF-8?B?VGhhbmsgeW91?= for applying')).toBe('Thank you for applying');
    expect(decodeHeader('=?utf-8?Q?Caf=C3=A9_role?=')).toBe('Café role');
  });

  test('matches by company domain and title, refuses ambiguous matches', async () => {
    const { store, app } = await seeded();
    const e = parseEmail(email('Acme Recruiting <jobs@acme.com>', 'Thanks for applying', 'We got it.'));
    expect(matchApplication(store, e)?.id).toBe(app.id);
    const job2 = store.upsertJob({ company: 'Acme Inc', title: 'SDET', descriptionText: 'x' });
    const app2 = store.createApplication(job2.id);
    await store.setStatus(app2.id, 'applied');
    expect(matchApplication(store, e)).toBeNull();
    const titled = parseEmail(email('Acme Recruiting <jobs@acme.com>', 'Your SDET application', 'We got it.'));
    expect(matchApplication(store, titled)?.id).toBe(app2.id);
  });

  test('scan moves status, texts, and processes each message once', async () => {
    const { store, sms, app } = await seeded();
    const msgs: Record<string, string> = {
      a: email('Acme <no-reply@acme.com>', 'Thank you for applying to Acme', 'We have received your application for QA Engineer.'),
      b: email('Acme <no-reply@acme.com>', 'Acme assessment', 'Complete the CodeSignal assessment at https://app.codesignal.com/x'),
      c: email('Newsletter <news@shop.com>', 'Sale', 'Big sale'),
    };
    const mail = { search: async () => Object.keys(msgs), getRaw: async (id: string) => msgs[id], ownAddresses: () => ['sam@example.com'] };
    const r = await scanInbox(store, mail, sms);
    expect(r.updated.map((u) => u.to)).toEqual(['acknowledged', 'assessment']);
    expect(store.getApplication(app.id)!.status).toBe('assessment');
    expect(sms.sent[1]).toMatch(/ASSESSMENT.*codesignal/);
    expect((await scanInbox(store, mail, sms)).scanned).toBe(0);
  });

  test('interview email moves screening to interviewing; unmatched interview still texts', async () => {
    const { store, sms, app } = await seeded('screening');
    const msgs: Record<string, string> = {
      a: email('Jane <jane@acme.com>', 'Acme next round', 'Please schedule an interview: https://calendly.com/jane/45'),
      b: email('Bob <bob@globex.com>', 'Quick chat?', 'Can we schedule a call? https://calendly.com/bob'),
    };
    const mail = { search: async () => Object.keys(msgs), getRaw: async (id: string) => msgs[id], ownAddresses: () => [] };
    await scanInbox(store, mail, sms);
    expect(store.getApplication(app.id)!.status).toBe('interviewing');
    expect(sms.sent.some((s) => /Possible interview email from Bob/.test(s))).toBe(true);
  });
});

describe('lifecycle', () => {
  test('sweeps 30-day silence to ghosted and builds a digest', async () => {
    let t = 1_000_000;
    const store = new JobHuntStore({ path: ':memory:', now: () => t });
    const job = store.upsertJob({ company: 'Acme', title: 'QA', descriptionText: 'x' });
    const app = store.createApplication(job.id);
    await store.setStatus(app.id, 'applied');
    expect(await sweepStale(store, { now: t + 29 * 86_400_000 })).toEqual([]);
    t += 31 * 86_400_000;
    expect(await sweepStale(store, { now: t })).toEqual([app.id]);
    expect(store.getApplication(app.id)!.status).toBe('ghosted');
    const digest = buildDigest(store, { since: t - 1000, now: t });
    expect(digest).toMatch(/Daily digest/);
    expect(digest).toMatch(/1 ghosted/);
  });
});

describe('text replies', () => {
  test('YES approves, SKIP withdraws, PAUSE pauses, bad codes explain', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const sms = fakeSms();
    const approved: string[] = [];
    const deps = { store, sms, approve: async (id: string) => { approved.push(id); } };
    const j1 = store.upsertJob({ company: 'Acme', title: 'QA', descriptionText: 'x' });
    store.setJobFit(j1.id, { score: 70, route: 'needs_approval', detail: {} });
    const a1 = store.createApplication(j1.id);
    const j2 = store.upsertJob({ company: 'Globex', title: 'SDET', descriptionText: 'x' });
    const a2 = store.createApplication(j2.id);
    expect(await handleReply(`yes ${a1.id.slice(0, 4)}`, deps)).toMatch(/Tailoring Acme/);
    expect(approved).toEqual([a1.id]);
    expect(await handleReply(`SKIP ${a2.id.slice(0, 4)}`, deps)).toMatch(/Skipped Globex/);
    expect(store.getApplication(a2.id)!.status).toBe('withdrawn');
    expect(await handleReply('YES zzzz', deps)).toMatch(/No posting/);
    await handleReply('pause', deps);
    expect(isPaused(store)).toBe(true);
    expect(await handleReply('STATUS', deps)).toMatch(/PAUSED/);
    expect(await handleReply('what', deps)).toMatch(/Commands/);
  });

  test('processReplies answers each inbound text once', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const sms = fakeSms();
    const inbox = { list: async () => [{ sid: 'SM1', from: '+1', body: 'STATUS', dateSent: Date.now() }] };
    const deps = { store, sms, approve: async () => {} };
    expect(await processReplies(inbox, deps)).toBe(1);
    expect(await processReplies(inbox, deps)).toBe(0);
    expect(sms.sent).toEqual(['[Job] no applications yet']);
  });
});

describe('discovery', () => {
  const greenhouse = {
    jobs: [
      { id: 1, title: 'QA Automation Engineer', location: { name: 'Remote' }, absolute_url: 'https://x/1', content: '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Cypress and Playwright&lt;/li&gt;&lt;li&gt;Postman and SQL&lt;/li&gt;&lt;li&gt;API testing&lt;/li&gt;&lt;/ul&gt;Remote. $90,000 - $110,000' },
      { id: 2, title: 'Senior QA Engineer', location: { name: 'Remote' }, absolute_url: 'https://x/2', content: 'Requirements: Cypress, Postman. Remote.' },
      { id: 3, title: 'Account Executive', location: { name: 'Remote' }, absolute_url: 'https://x/3', content: 'Sales' },
      { id: 4, title: 'QA Lead', location: { name: 'Remote' }, absolute_url: 'https://x/4', content: 'Requirements:\n- 15+ years of QA' },
    ],
  };
  const fetchImpl: any = async (url: string) => ({ ok: true, json: async () => (url.includes('greenhouse') ? greenhouse : []) });

  test('title filter and canonical key', () => {
    expect(titleAllowed('Senior QA Engineer', {})).toBe(true);
    expect(titleAllowed('Software Engineer in Test', {})).toBe(true);
    expect(titleAllowed('Account Executive', {})).toBe(false);
    expect(titleAllowed('QA Intern', {})).toBe(false);
    expect(canonicalKey({ company: 'Acme Inc', title: 'Sr QA Engineer', location: 'Remote, US' })).toBe(canonicalKey({ company: 'acme', title: 'Senior QA Engineer', location: 'remote' }));
  });

  test('fetches a Greenhouse board', async () => {
    const jobs = await fetchBoard({ ats: 'greenhouse', slug: 'acme', name: 'Acme' }, fetchImpl);
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toMatchObject({ source: 'greenhouse', sourceId: 'acme:1', company: 'Acme', title: 'QA Automation Engineer' });
  });

  test('ranks, respects the daily target, stores filtered jobs, and dedupes next run', async () => {
    const store = new JobHuntStore({ path: ':memory:' });
    const prefs = { watchlist: [{ ats: 'greenhouse' as const, slug: 'acme', name: 'Acme' }], dailyTarget: 1, salaryFloor: 65000, autoTailorAt: 70, approvalAt: 50 };
    const now = Date.parse('2026-11-14T15:00:00Z');
    const r1 = await discover(store, MASTER, prefs, { fetchImpl, now });
    expect(r1.titleMatched).toBe(3);
    expect(r1.filteredOut).toBe(1); // 15+ years
    expect(r1.admitted).toHaveLength(1);
    expect(r1.admitted[0].posting.sourceId).toBe('acme:1');
    expect(r1.deferred).toBe(1);
    // Admitted postings are added by the caller; simulate that.
    store.createApplication(store.upsertJob(r1.admitted[0].posting).id);
    const r2 = await discover(store, MASTER, prefs, { fetchImpl, now: now + 3_600_000 });
    expect(r2.admitted).toHaveLength(0); // quota used up today
    const r3 = await discover(store, MASTER, prefs, { fetchImpl, now: now + 86_400_000 });
    expect(r3.admitted.map((a) => a.posting.sourceId)).toEqual(['acme:2']);
  });

  test('facade discover adds, texts and auto-tailors; scheduler runs it once per window', async () => {
    const sms = fakeSms();
    const jh = createJobHunt({
      store: new JobHuntStore({ path: ':memory:' }), sms, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: null,
      masterResume: MASTER, fetchImpl, preferences: { watchlist: [{ ats: 'greenhouse', slug: 'acme', name: 'Acme' }], dailyTarget: 5, autoTailorAt: 70, approvalAt: 50 },
    });
    const noon = new Date('2026-11-14T12:00:00');
    const ran = await runDue(jh, { now: () => noon, log: () => {} });
    expect(ran).toContain('discover');
    expect(jh.list().length).toBe(2);
    expect(sms.sent.some((s) => /(New|TOP MATCH, apply fast): Acme, QA Automation Engineer/.test(s))).toBe(true);
    const again = await runDue(jh, { now: () => new Date(noon.getTime() + 60_000), log: () => {} });
    expect(again).not.toContain('discover');
    const evening = await runDue(jh, { now: () => new Date('2026-11-14T18:31:00'), log: () => {} });
    expect(evening).toContain('digest');
    expect(sms.sent[sms.sent.length - 1]).toMatch(/Daily digest/);
    jh.close();
  });
});

describe('US location and QA title filters', () => {
  test('isUsLocation', () => {
    const { isUsLocation } = require('../jobhunt/scoring');
    expect(isUsLocation('Remote - USA')).toBe(true);
    expect(isUsLocation('Cincinnati, OH')).toBe(true);
    expect(isUsLocation('Bengaluru, India')).toBe(false);
    expect(isUsLocation('Canada - Remote (ON, AB, BC, or NS Only)')).toBe(false);
    expect(isUsLocation('Remote, Canada; Remote, United States')).toBe(true);
    expect(isUsLocation(null)).toBe(true);
  });
  test('non-software quality roles are excluded', () => {
    expect(titleAllowed('Food Safety Quality Area Manager', {})).toBe(false);
    expect(titleAllowed('2027 Early Career Flight Test Engineer', {})).toBe(false);
    expect(titleAllowed('QA/DevOps Engineer', {})).toBe(true);
    expect(titleAllowed('Senior Software Engineer, Mobile QA', {})).toBe(true);
    expect(titleAllowed('Software Quality Assurance Engineer', {})).toBe(true);
  });
});

describe('tracking dashboard', () => {
  const { furthestStage, dashboardRows, renderDashboard, linkedinSearch } = require('../jobhunt/dashboard');
  const { senderContact } = require('../jobhunt/inbox');

  test('furthestStage keeps the deepest stage reached, even after a rejection', () => {
    expect(furthestStage(['saved', 'tailored', 'applied', 'screening', 'rejected'])).toBe('screening');
    expect(furthestStage(['saved'])).toBe('saved');
  });

  test('senderContact skips ATS and no-reply senders and reads a signature title', () => {
    const human = parseEmail(email('Jane Doe <jane@acme.com>', 'Next steps', 'Hi Sam,\nLet us talk.\n\nJane Doe\nTechnical Recruiter\nAcme'));
    expect(senderContact(human)).toEqual({ name: 'Jane Doe', email: 'jane@acme.com', title: 'Technical Recruiter' });
    expect(senderContact(parseEmail(email('Acme <no-reply@acme.com>', 'Thanks', 'Received')))).toBeNull();
    expect(senderContact(parseEmail(email('Acme Hiring <notifications@greenhouse.io>', 'Thanks', 'Received')))).toBeNull();
  });

  test('upsertContact merges by email and by name (no duplicates)', async () => {
    const { store, app } = await seeded();
    store.upsertContact({ applicationId: app.id, name: 'Jane Doe', source: 'manual' });
    store.upsertContact({ applicationId: app.id, name: 'Jane Doe', linkedinUrl: 'https://www.linkedin.com/in/janedoe', source: 'manual' });
    store.upsertContact({ applicationId: app.id, email: 'Bob@Acme.com', source: 'email' });
    store.upsertContact({ applicationId: app.id, email: 'bob@acme.com', name: 'Bob Smith', title: 'QA Manager', source: 'email' });
    expect(store.contacts(app.id)).toEqual([
      { name: 'Jane Doe', title: null, email: null, linkedinUrl: 'https://www.linkedin.com/in/janedoe', source: 'manual' },
      { name: 'Bob Smith', title: 'QA Manager', email: 'bob@acme.com', linkedinUrl: null, source: 'email' },
    ]);
  });

  test('rows and HTML show result, how far it got, documents and contacts', async () => {
    const { store, app } = await seeded('screening');
    await store.setStatus(app.id, 'rejected', { reason: 'email: rejection' });
    store.upsertContact({ applicationId: app.id, name: 'Bob Smith', title: 'QA Manager', email: 'bob@acme.com', source: 'email' });
    const [row] = dashboardRows(store, null);
    expect(row.furthest).toBe('screening');
    expect(row.result).toBe('Rejected');
    expect(row.contacts[0].linkedin).toBe(linkedinSearch('Bob Smith Acme Inc'));
    expect(row.hiringSearch).toContain('linkedin.com/search/results/people');
    const html = renderDashboard(dashboardRows(store, null), { now: Date.parse('2026-11-14T12:00:00Z') });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Acme Inc');
    expect(html).toContain('Bob Smith');
    expect(html).not.toMatch(/—/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    const evil = await seeded();
    evil.store.upsertContact({ applicationId: evil.app.id, name: '<img src=x onerror=alert(1)>', source: 'manual' });
    expect(renderDashboard(dashboardRows(evil.store, null))).not.toContain('<img src=x');
  });
});
