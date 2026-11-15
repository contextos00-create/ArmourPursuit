'use strict';

import { detectBounce } from '../jobhunt/bounce';
import { scanForBounces } from '../jobhunt/bounce-monitor';
import { writeCoverLetter } from '../jobhunt/cover-letter';
import { checkGrounded } from '../jobhunt/grounding';
import { createJobHunt } from '../jobhunt/index';
import { auditTextLayer, renderResumePdf, type PdfTools } from '../jobhunt/pdf';
import { parsePostingUrl, fetchPosting } from '../jobhunt/postings';
import { extractRequirements } from '../jobhunt/requirements';
import { detectWorkMode, levelFromTitle, parseSalary, requiredYears, scoreFit, yearsOfExperience } from '../jobhunt/scoring';
import { attachSmsNotifier, createTwilioSender, formatStatusSms, type SmsSender } from '../jobhunt/sms';
import { JobHuntStore, TransitionError } from '../jobhunt/store';
import { tailorResume } from '../jobhunt/tailor';
import { htmlToText } from '../jobhunt/text';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', label: 'Software Engineer', email: 'sam@example.com', summary: 'Engineer who builds data products.' },
  work: [
    {
      name: 'Northwind', position: 'Senior Software Engineer', startDate: '2022-01', endDate: '',
      highlights: [
        'Built a TypeScript and React dashboard used by 40 internal analysts',
        'Cut Postgres query latency 35% by adding indexes and rewriting reports',
        'Organized the team offsite and quarterly hack week',
        'Mentored 3 junior engineers through code review and pairing',
      ],
    },
    {
      name: 'Contoso', position: 'Software Engineer', startDate: '2019-06', endDate: '2021-12',
      highlights: ['Wrote Python ETL jobs moving 2M rows a day into BigQuery', 'Maintained the Jenkins CI pipeline'],
    },
  ],
  skills: [
    { name: 'Languages', keywords: ['Python', 'TypeScript', 'SQL'] },
    { name: 'Frontend', keywords: ['React', 'CSS'] },
    { name: 'Data', keywords: ['Postgres', 'BigQuery'] },
  ],
  education: [{ institution: 'State University', area: 'Computer Science', studyType: 'BS', endDate: '2019' }],
};

const POSTING = `
About the role
We are hiring a Senior Frontend Engineer.

Requirements:
- 5+ years building web apps with TypeScript and React
- Experience with Postgres and SQL performance tuning
- Kubernetes in production

Nice to have:
- GraphQL
- Mentoring engineers

Benefits
- Free lunch and React stickers
`;

function memStore(now = () => 1_000) {
  return new JobHuntStore({ path: ':memory:', now });
}

function fakeSms(): SmsSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: async (body) => { sent.push(body); return { status: 'sent', providerId: `SM${sent.length}`, error: null }; } };
}

describe('requirements', () => {
  test('splits must and nice sections and skips benefits', () => {
    const reqs = extractRequirements(POSTING, MASTER);
    const must = reqs.filter((r) => r.kind === 'must').flatMap((r) => r.keywords);
    const nice = reqs.filter((r) => r.kind === 'nice').flatMap((r) => r.keywords);
    expect(must).toEqual(expect.arrayContaining(['typescript', 'react', 'postgres', 'sql', 'kubernetes']));
    expect(nice).toEqual(expect.arrayContaining(['graphql', 'mentoring']));
    expect(reqs.some((r) => /lunch/.test(r.text))).toBe(false);
  });
});

describe('tailoring', () => {
  const job = { id: 'j1', source: 'manual' as const, sourceId: null, url: null, company: 'Acme', title: 'Senior Frontend Engineer', location: null, descriptionText: POSTING, createdAt: 0 };

  test('ranks relevant bullets first, reports gaps, never adds missing skills', async () => {
    const t = await tailorResume(MASTER, job, { generate: null });
    const northwind = t.resume.work![0].highlights!;
    expect(northwind[0]).toMatch(/TypeScript and React/);
    expect(northwind).not.toContain('Organized the team offsite and quarterly hack week');
    expect(t.report.gaps).toEqual(expect.arrayContaining(['kubernetes', 'graphql']));
    expect(t.markdown).not.toMatch(/kubernetes|graphql/i);
    expect(t.report.fitScore).toBeGreaterThan(0);
    expect(t.report.fitScore).toBeLessThan(100);
    expect(t.markdown).toContain('Jan 2022 to Present');
    expect(t.markdown).toContain('Jun 2019 to Dec 2021');
    // Every role is kept so the work history has no holes.
    expect(t.resume.work).toHaveLength(2);
  });

  test('keeps grounded LLM rewrites and discards ones that invent facts', async () => {
    const generate = async (prompt: string) => prompt.includes('JSON object') ? JSON.stringify({
      'w0.0': 'Built a React and TypeScript dashboard used by 40 internal analysts',
      'w0.1': 'Cut Postgres query latency 60% across Kubernetes clusters', // invented number + skill
      'w0.3': 'Mentored 3 junior engineers through code review and pairing',
    }) : 'Engineer who builds React data products.';
    const t = await tailorResume(MASTER, job, { generate });
    const bullets = t.resume.work![0].highlights!;
    expect(bullets).toContain('Built a React and TypeScript dashboard used by 40 internal analysts');
    expect(bullets).toContain('Cut Postgres query latency 35% by adding indexes and rewriting reports');
    expect(t.report.rejectedRewrites).toHaveLength(1);
    expect(t.report.rejectedRewrites[0].reason).toMatch(/60/);
    expect(t.resume.basics.summary).toBe('Engineer who builds React data products.');
  });

  test('summary rewrite that adds years of experience is rejected', async () => {
    const generate = async (prompt: string) => prompt.includes('JSON object') ? '{}' : 'Engineer with 10 years building data products.';
    const t = await tailorResume(MASTER, job, { generate });
    expect(t.resume.basics.summary).toBe('Engineer who builds data products.');
    expect(t.report.rejectedRewrites[0].reason).toMatch(/10/);
  });

  test('without an LLM the summary names matched skills in resume casing', async () => {
    const t = await tailorResume(MASTER, job, { generate: null });
    expect(t.resume.basics.summary).toMatch(/^Engineer who builds data products\. Relevant to this role: .*TypeScript.*\.$/);
  });

  test('synonyms count as evidence and impact bullets survive', async () => {
    const master: MasterResume = {
      ...MASTER,
      work: [{ name: 'Northwind', position: 'QA Engineer', startDate: '2022-01', highlights: [
        'Wrote End-to-End tests in Cypress for checkout',
        'Owned release validation for a platform serving 4M+ screens',
        'Attended weekly planning meetings',
      ] }],
    };
    const qaJob = { ...job, descriptionText: 'Requirements:\n- E2E testing with Cypress\n- Postgresql' };
    const t = await tailorResume(master, qaJob, { generate: null, maxBulletsPerRole: 2 });
    expect(t.report.gaps).not.toContain('e2e');
    expect(t.report.gaps).not.toContain('postgresql');
    expect(t.resume.work![0].highlights).toEqual(['Wrote End-to-End tests in Cypress for checkout', 'Owned release validation for a platform serving 4M+ screens']);
  });

  test('grounding check catches new names, skills and em dashes', () => {
    const src = 'Built a dashboard for Northwind analysts';
    expect(checkGrounded('Built a dashboard for Northwind analysts', src, [src]).ok).toBe(true);
    expect(checkGrounded('Built a dashboard for Google analysts', src, [src]).ok).toBe(false);
    expect(checkGrounded('Built a kubernetes dashboard', src, [src], ['kubernetes']).ok).toBe(false);
    expect(checkGrounded('Built a dashboard — fast', src, [src]).ok).toBe(false);
  });

  test('cover letter drops sentences with unsupported claims', async () => {
    const t = await tailorResume(MASTER, job, { generate: null });
    const generate = async () => [
      'I am excited to apply for the Senior Frontend Engineer role at Acme.',
      '',
      'At Northwind I built a TypeScript and React dashboard used by 40 internal analysts. I also ran Kubernetes for 200 services.',
      '',
      'I would welcome a conversation about the role.',
    ].join('\n');
    const letter = await writeCoverLetter(MASTER, job, t, { generate });
    expect(letter.report.generatedBy).toBe('llm');
    expect(letter.markdown).toMatch(/40 internal analysts/);
    expect(letter.markdown).not.toMatch(/Kubernetes|200/);
    expect(letter.report.rejectedSentences.length).toBe(1);
    expect(letter.markdown).not.toMatch(/—/);
  });

  test('template cover letter without an LLM uses real bullets', async () => {
    const t = await tailorResume(MASTER, job, { generate: null });
    const letter = await writeCoverLetter(MASTER, job, t);
    expect(letter.report.generatedBy).toBe('template');
    expect(letter.markdown).toMatch(/Senior Software Engineer at Northwind/);
    expect(letter.html).toContain('<!doctype html>');
  });
});

describe('tracker and SMS', () => {
  test('records history, enforces transitions, and texts on every change', async () => {
    const store = memStore();
    const sms = fakeSms();
    attachSmsNotifier(store, sms);
    const job = store.upsertJob({ company: 'Acme', title: 'Engineer', descriptionText: POSTING });
    const app = store.createApplication(job.id, { contactEmail: 'Jobs <JOBS@acme.com>' });
    expect(app.contactEmail).toBe('jobs@acme.com');
    await store.setStatus(app.id, 'applied');
    await store.setStatus(app.id, 'screening', { reason: 'recruiter call booked' });
    await expect(store.setStatus(app.id, 'saved')).rejects.toBeInstanceOf(TransitionError);
    expect(store.history(app.id).map((e) => e.toStatus)).toEqual(['saved', 'applied', 'screening']);
    const c = app.id.slice(0, 4);
    expect(sms.sent).toEqual([`[Job ${c}] Acme, Engineer: saved to applied`, `[Job ${c}] Acme, Engineer: applied to screening (recruiter call booked)`]);
    expect(store.notifications(app.id).map((n) => n.status)).toEqual(['sent', 'sent']);
    expect(store.getApplication(app.id)!.appliedAt).toBe(1_000);
  });

  test('upsertJob dedupes by source id', () => {
    const store = memStore();
    const a = store.upsertJob({ source: 'lever', sourceId: 'acme:1', company: 'Acme', title: 'A', descriptionText: 'x' });
    const b = store.upsertJob({ source: 'lever', sourceId: 'acme:1', company: 'Acme', title: 'A (updated)', descriptionText: 'y' });
    expect(b.id).toBe(a.id);
    expect(b.title).toBe('A (updated)');
  });

  test('Twilio sender posts the documented form and dry-runs without config', async () => {
    const calls: any[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ sid: 'SM123' }) };
    };
    const sender = createTwilioSender({ accountSid: 'AC1', authUser: 'AC1', authSecret: 'tok', from: '+15550001111', to: '+15552223333' }, fetchImpl);
    expect(await sender.send('hi')).toEqual({ status: 'sent', providerId: 'SM123', error: null });
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    const body = new URLSearchParams(calls[0].init.body);
    expect(body.get('To')).toBe('+15552223333');
    expect(body.get('From')).toBe('+15550001111');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
    expect((await createTwilioSender(null).send('x')).status).toBe('dry-run');
  });

  test('formatStatusSms caps length', () => {
    const long = 'x'.repeat(400);
    const msg = formatStatusSms({ job: { company: 'A', title: 'B' } as any, application: { id: 'abcd1234' } as any, event: { fromStatus: 'applied', toStatus: 'rejected', reason: long } as any });
    expect(msg.length).toBeLessThanOrEqual(300);
  });
});

const DSN = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: sam@example.com',
  'Subject: Delivery Status Notification (Failure)',
  'In-Reply-To: <orig-123@mail.example.com>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  "Address not found. Your message wasn't delivered to jobs@acme.com because the address couldn't be found.",
  '',
  '--BOUND',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; googlemail.com',
  '',
  'Final-Recipient: rfc822; jobs@acme.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.',
  '',
  '--BOUND',
  'Content-Type: text/rfc822-headers',
  '',
  'Message-ID: <orig-123@mail.example.com>',
  'To: jobs@acme.com',
  'Subject: Application: Engineer',
  '',
  '--BOUND--',
  '',
].join('\r\n');

const DELAYED = DSN.replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.7').replace('Diagnostic-Code: smtp; 550 5.1.1', 'Diagnostic-Code: smtp; 421 4.4.7');

const PLAIN_BOUNCE = [
  'From: MAILER-DAEMON@mx.acme.com',
  'To: sam@example.com',
  'Subject: Undeliverable: Application',
  'Content-Type: text/plain',
  '',
  'This is the mail system at host mx.acme.com.',
  'I\'m sorry to have to inform you that your message could not be delivered.',
  '<hr@acme.com>: host mx.acme.com said: 550 5.1.1 User unknown',
].join('\n');

describe('bounce detection', () => {
  test('parses a standard DSN', () => {
    const info = detectBounce(DSN, ['sam@example.com']);
    expect(info).toMatchObject({ isBounce: true, permanent: true, recipients: ['jobs@acme.com'], status: '5.1.1' });
    expect(info.originalMessageIds).toContain('orig-123@mail.example.com');
    expect(info.diagnostic).toMatch(/does not exist/);
  });

  test('ignores delayed notices', () => {
    expect(detectBounce(DELAYED).isBounce).toBe(false);
  });

  test('handles non-standard mailer-daemon text bounces', () => {
    const info = detectBounce(PLAIN_BOUNCE, ['sam@example.com']);
    expect(info.isBounce).toBe(true);
    expect(info.recipients).toEqual(['hr@acme.com']);
    expect(info.status).toBe('5.1.1');
  });

  test('base64 encoded delivery-status part', () => {
    const b64 = Buffer.from('Final-Recipient: rfc822; x@y.com\r\nAction: failed\r\nStatus: 5.2.1\r\n').toString('base64');
    const raw = DSN.replace('Content-Type: message/delivery-status\r\n', 'Content-Type: message/delivery-status\r\nContent-Transfer-Encoding: base64\r\n')
      .replace(/Reporting-MTA[\s\S]*?does not exist\.\r\n/, `${b64}\r\n`);
    expect(detectBounce(raw).recipients).toEqual(['x@y.com']);
  });
});

describe('bounce monitor', () => {
  function mailbox(messages: Record<string, string>) {
    return { search: async () => Object.keys(messages), getRaw: async (id: string) => messages[id], ownAddresses: () => ['sam@example.com'] };
  }

  test('flags the matching application, texts once, and does not reprocess', async () => {
    const store = memStore();
    const sms = fakeSms();
    attachSmsNotifier(store, sms);
    const job = store.upsertJob({ company: 'Acme', title: 'Engineer', descriptionText: POSTING });
    const app = store.createApplication(job.id);
    await store.setStatus(app.id, 'applied');
    store.recordSentEmail(app.id, '<orig-123@mail.example.com>', 'jobs@acme.com');
    sms.sent.length = 0;

    const mail = mailbox({ m1: DSN, m2: DELAYED });
    const r1 = await scanForBounces(store, mail, sms);
    expect(r1.flagged).toEqual([{ applicationId: app.id, recipient: 'jobs@acme.com' }]);
    expect(store.getApplication(app.id)!.status).toBe('bounced');
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatch(/Acme, Engineer: applied to EMAIL BOUNCED \(email to jobs@acme.com bounced, 5\.1\.1\)/);

    const r2 = await scanForBounces(store, mail, sms);
    expect(r2.scanned).toBe(0);
    expect(sms.sent).toHaveLength(1);
  });

  test('matches by recipient address when no Message-ID is recorded, and texts unmatched bounces', async () => {
    const store = memStore();
    const sms = fakeSms();
    attachSmsNotifier(store, sms);
    const job = store.upsertJob({ company: 'Globex', title: 'Analyst', descriptionText: POSTING });
    const app = store.createApplication(job.id, { contactEmail: 'hr@acme.com' });
    await store.setStatus(app.id, 'applied');
    sms.sent.length = 0;
    const r = await scanForBounces(store, mailbox({ a: PLAIN_BOUNCE, b: DSN }), sms);
    expect(r.flagged.map((x) => x.applicationId)).toEqual([app.id]);
    expect(r.unmatched).toEqual([{ recipient: 'jobs@acme.com', messageId: 'b' }]);
    expect(sms.sent[1]).toMatch(/jobs@acme.com bounced and is not linked/);
  });
});

describe('postings', () => {
  test('parses supported ATS URLs', () => {
    expect(parsePostingUrl('https://boards.greenhouse.io/acme/jobs/123')).toEqual({ source: 'greenhouse', board: 'acme', id: '123' });
    expect(parsePostingUrl('https://job-boards.greenhouse.io/acme/jobs/456?gh_src=x')).toEqual({ source: 'greenhouse', board: 'acme', id: '456' });
    expect(parsePostingUrl('https://jobs.lever.co/acme/abc-def')).toEqual({ source: 'lever', company: 'acme', id: 'abc-def' });
    expect(parsePostingUrl('https://jobs.ashbyhq.com/acme/uuid-1')).toEqual({ source: 'ashby', org: 'acme', id: 'uuid-1' });
    expect(parsePostingUrl('https://www.linkedin.com/jobs/view/1')).toBeNull();
  });

  test('fetches and cleans a Greenhouse posting', async () => {
    const fetchImpl: any = async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/jobs/123')
        ? { id: 123, title: 'Engineer', location: { name: 'Remote' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/123', content: '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;React &amp;amp; TypeScript&lt;/li&gt;&lt;/ul&gt;' }
        : { name: 'Acme Corp' },
    });
    const p = await fetchPosting('https://boards.greenhouse.io/acme/jobs/123', fetchImpl);
    expect(p).toMatchObject({ source: 'greenhouse', sourceId: 'acme:123', company: 'Acme Corp', title: 'Engineer', location: 'Remote' });
    expect(p.descriptionText).toBe('Requirements\n- React & TypeScript');
  });

  test('htmlToText keeps list structure', () => {
    expect(htmlToText('<p>Hi</p><ul><li>One</li><li>Two</li></ul>')).toBe('Hi\n- One\n- Two');
  });
});

describe('pdf gates', () => {
  const job = { id: 'j1', source: 'manual' as const, sourceId: null, url: null, company: 'Acme', title: 'Senior Frontend Engineer', location: null, descriptionText: POSTING, createdAt: 0 };
  // Fake renderer: one page per 4 bullets; text layer is the HTML with tags stripped.
  const fakeTools: PdfTools = {
    render: async (html) => Buffer.from(html),
    inspect: async (pdf) => {
      const html = pdf.toString();
      return { pages: Math.ceil((html.match(/<li>/g) || []).length / 7), text: htmlToText(html).toUpperCase().replace(/SAM RIVERA/, 'Sam Rivera').replace(/NORTHWIND/g, 'Northwind').replace(/CONTOSO/g, 'Contoso') };
    },
  };

  test('trims lowest-relevance bullets until it fits, keeping one per role', async () => {
    const t = await tailorResume(MASTER, job, { generate: null });
    const r = await renderResumePdf(t, job, { tools: fakeTools, pageBudget: 1 });
    expect(r.audit.pages).toBe(1);
    expect(r.audit.trimmed.length).toBeGreaterThan(0);
    expect(r.resume.work!.every((w) => w.highlights!.length >= 1)).toBe(true);
    // The most relevant bullet survives.
    expect(r.resume.work![0].highlights![0]).toMatch(/TypeScript and React/);
    expect(r.audit.textLayer).toEqual({ ok: true, problems: [] });
  });

  test('text-layer audit catches missing sections and ligatures', () => {
    const a = auditTextLayer('Sam Rivera\nSKILLS\nEXPERIENCE Northwind Contoso \uFB01nance', MASTER);
    expect(a.ok).toBe(false);
    expect(a.problems.join(' ')).toMatch(/SUMMARY.*missing/);
    expect(a.problems.join(' ')).toMatch(/ligature/);
  });
});

describe('fit scoring', () => {
  const base = { id: 'j', source: 'manual' as const, sourceId: null, url: null, location: 'Remote', createdAt: 0 };
  const now = new Date('2026-11-01');

  test('helpers parse level, mode, pay, years', () => {
    expect(levelFromTitle('Senior Frontend Engineer')).toBe('senior');
    expect(levelFromTitle('Staff Engineer')).toBe('staff');
    expect(levelFromTitle('Engineering Manager')).toBe('manager');
    expect(levelFromTitle('Product Manager')).toBeNull();
    expect(detectWorkMode('This is a hybrid role in Austin')).toBe('hybrid');
    expect(parseSalary('Pay: $140,000 - $180,000 per year')).toEqual({ min: 140000, max: 180000 });
    expect(parseSalary('$120k to $150k')).toEqual({ min: 120000, max: 150000 });
    expect(requiredYears('5+ years of TypeScript, 2 years of Go')).toBe(5);
    expect(yearsOfExperience(MASTER, now)).toBeCloseTo(7.4, 0);
  });

  test('strong match auto-tailors, weak match is filtered', () => {
    const strong = { ...base, company: 'Acme', title: 'Senior Software Engineer',
      descriptionText: 'Requirements:\n- TypeScript and React\n- Postgres and SQL\n- Python\nFully remote. $150,000 - $190,000' };
    const fit = scoreFit(MASTER, strong, { workModes: ['remote'], salaryFloor: 140000, domains: ['dashboards'] }, now);
    expect(fit.breakdown.skills).toBe(40);
    expect(fit.score).toBeGreaterThanOrEqual(80);
    expect(fit.route).toBe('auto_tailor');

    const weak = { ...base, company: 'Initech', title: 'Junior iOS Developer', descriptionText: 'Requirements:\n- Swift\n- Kotlin\n- Figma' };
    expect(scoreFit(MASTER, weak, {}, now).route).toBe('filtered_out');
  });

  test('hard filters and dream-company override', () => {
    const job = { ...base, company: 'Globex', title: 'Senior Software Engineer', descriptionText: 'Requirements:\n- 12+ years of TypeScript' };
    const fit = scoreFit(MASTER, job, {}, now);
    expect(fit.route).toBe('filtered_out');
    expect(fit.hardFilter).toMatch(/12\+ years/);
    expect(scoreFit(MASTER, { ...job, descriptionText: 'Requirements:\n- TypeScript' }, { blockedCompanies: ['globex'] }, now).hardFilter).toMatch(/blocked/);
    expect(scoreFit(MASTER, { ...job, descriptionText: 'We are unable to sponsor visas.' }, { needsSponsorship: true }, now).hardFilter).toMatch(/sponsorship/);
    const mid = { ...job, descriptionText: 'Requirements:\n- TypeScript\n- Kubernetes\n- Terraform' };
    const plain = scoreFit(MASTER, mid, {}, now);
    expect(plain.route).not.toBe('auto_tailor');
    expect(scoreFit(MASTER, mid, { dreamCompanies: ['Globex'] }, now).route).toBe('needs_approval');
  });
});

describe('facade', () => {
  test('add scores and texts, approve tailors, filtered postings need force', async () => {
    const sms = fakeSms();
    const jh = createJobHunt({ store: memStore(), sms, mail: null, generate: null, masterResume: MASTER, outputDir: null, preferences: {}, pdf: null });
    const { application, fit, tailored } = await jh.addPosting({ company: 'Acme', title: 'Senior Frontend Engineer', descriptionText: POSTING });
    expect(fit).not.toBeNull();
    expect(sms.sent[0]).toMatch(new RegExp(`^\\[Job ${application.id.slice(0, 4)}\\] New: Acme, Senior Frontend Engineer\\. Fit ${fit!.score}`));
    if (fit!.route === 'filtered_out') await expect(jh.tailor(application.id)).rejects.toThrow(/filtered out/);
    expect(tailored).toBeNull();
    const r = await jh.approve(application.id);
    expect(r.resume.markdown).toMatch(/^# Sam Rivera/);
    expect(r.coverLetter.markdown).toMatch(/^Dear Hiring Manager,/);
    expect(jh.store.getApplication(application.id)!.status).toBe('tailored');
    expect(sms.sent[1]).toMatch(/saved to resume \+ cover letter ready \(fit \d+%, gaps: /);
    expect(jh.store.latestDocument(application.id, 'cover_letter')!.id).toBe(r.coverLetter.id);
    jh.close();
  });

  test('a high-fit posting is tailored automatically', async () => {
    const sms = fakeSms();
    const jh = createJobHunt({ store: memStore(), sms, mail: null, generate: null, masterResume: MASTER, outputDir: null, pdf: null,
      preferences: { workModes: ['remote'], salaryFloor: 140000, domains: ['dashboards'] } });
    const r = await jh.addPosting({ company: 'Acme', title: 'Senior Software Engineer', location: 'Remote',
      descriptionText: 'Requirements:\n- TypeScript and React\n- Postgres and SQL\n- Python\nBuild analytics dashboards. Fully remote. $150,000 - $190,000' });
    expect(r.fit!.route).toBe('auto_tailor');
    expect(r.tailored).not.toBeNull();
    expect(r.application.status).toBe('tailored');
    jh.close();
  });
});
