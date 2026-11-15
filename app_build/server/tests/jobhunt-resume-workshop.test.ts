'use strict';

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cc from '../jobhunt/command-center';
import { createJobHunt } from '../jobhunt/index';
import { keywordOutcomes, loadChoices, pageRefusal, researchCompany, suggestWording } from '../jobhunt/resume-workshop';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', label: 'QA Engineer', email: 'sam@example.com', summary: 'QA engineer with 6 years in test automation.' },
  work: [
    { name: 'Northwind', position: 'QA Automation Engineer', startDate: '2020-01', highlights: [
      'Built a Playwright suite covering 240 checkout flows',
      'Validated 50 REST API endpoints with Postman and SQL',
      'Cut regression time from 3 days to 4 hours with parallel CI runs',
      'Organized the team offsite',
    ] },
    { name: 'Contoso', position: 'QA Analyst', startDate: '2017-03', endDate: '2019-12', highlights: ['Wrote manual test plans for a billing system', 'Logged and triaged defects in Jira'] },
  ],
  skills: [{ name: 'Testing', keywords: ['Playwright', 'Postman', 'SQL', 'Jira', 'API'] }],
};
const POSTING = 'Requirements\n- Playwright or Cypress\n- REST API testing with Postman\n- SQL\n- Kubernetes\n\nNice to have\n- Docker\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-ws-'));
  const store = new JobHuntStore({ path: ':memory:' });
  const jh = createJobHunt({ store, sms: { send: async () => ({ status: 'sent', providerId: null, error: null }) }, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: {}, autoTailor: false });
  cc.pipeline(jh);
  return { dir, jh, store };
}

async function posting(s: ReturnType<typeof setup>, extra: any = {}) {
  return (await s.jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: POSTING, ...extra } as any)).application.id;
}

describe('resume workshop', () => {
  test('starts from the automatic selection and shows keyword coverage and gaps', async () => {
    const s = setup();
    const id = await posting(s);
    const v = await cc.resumeWorkshop(id);
    expect(v.gaps).toEqual(expect.arrayContaining(['kubernetes', 'docker']));
    expect(v.keywords.find((k) => k.term === 'playwright')).toMatchObject({ kind: 'must', onResume: true, inDraft: true });
    expect(v.keywords.find((k) => k.term === 'docker')).toMatchObject({ kind: 'nice', onResume: false, inDraft: false });
    const lines = v.roles[0].lines;
    expect(lines.find((l) => l.master.startsWith('Built a Playwright'))).toMatchObject({ on: true, auto: true, hits: ['playwright'] });
    expect(v.previewHtml).toContain('Built a Playwright suite covering 240 checkout flows');
    // Gaps are reported, never written in.
    expect(v.previewHtml).not.toMatch(/Kubernetes|Docker/);
    expect(v.hasModel).toBe(false);
  });

  test('choices: lines in and out, own wording, pin, summary, headline, skills, roles', async () => {
    const s = setup();
    const id = await posting(s);
    const v = await cc.saveResumeChoices(id, {
      headline: 'QA Automation Engineer', summaryMode: 'custom', summaryText: 'QA engineer focused on API and UI automation.',
      bullets: { 'w0.3': { on: true }, 'w0.2': { on: false }, 'w0.1': { text: 'Validated 50 REST API endpoints with Postman, SQL and Cypress across 9 services' }, 'bogus': { on: true } },
      pinned: ['w0.3'], rolesOff: ['w1'], skillsOff: ['Jira'], notes: 'Glassdoor reviews mention Cypress migrations.',
    });
    const role = v.roles[0];
    expect(role.lines[0]).toMatchObject({ id: 'w0.3', on: true, pinned: true });
    expect(role.lines.find((l) => l.id === 'w0.2')!.on).toBe(false);
    // The person's own wording is kept, and the new fact in it is pointed out.
    const mine = role.lines.find((l) => l.id === 'w0.1')!;
    expect(mine).toMatchObject({ edited: true, text: 'Validated 50 REST API endpoints with Postman, SQL and Cypress across 9 services' });
    expect(mine.flag).toMatch(/number "9" is not in your original line/);
    expect(v.headline.value).toBe('QA Automation Engineer');
    expect(v.previewHtml).toContain('QA engineer focused on API and UI automation.');
    expect(v.previewHtml).not.toContain('Contoso');
    expect(v.previewHtml).not.toContain('Cut regression time');
    expect(v.previewHtml).not.toMatch(/Jira/);
    expect(v.previewHtml.indexOf('Organized the team offsite')).toBeLessThan(v.previewHtml.indexOf('Built a Playwright'));
    expect(v.choices.bullets.bogus).toBeUndefined();
  });

  test('saving a version writes the files and automatic tailoring does not overwrite it', async () => {
    const s = setup();
    const id = await posting(s);
    await cc.saveResumeChoices(id, { bullets: { 'w0.3': { on: true }, 'w0.0': { on: false } } });
    const saved = await cc.resumeSaveVersion(id);
    expect(saved.message).toMatch(/^Saved\. This is now the resume used for Acme\./);
    const folder = readdirSync(join(s.dir, 'docs'))[0];
    const file = () => readFileSync(join(s.dir, 'docs', folder, 'resume.md'), 'utf8');
    expect(file()).toContain('Organized the team offsite');
    expect(file()).not.toContain('Built a Playwright suite');
    expect(s.jh.list()[0].status).toBe('tailored');
    await s.jh.tailor(id, { force: true }); // what approve and auto-apply call
    expect(file()).toContain('Organized the team offsite');
    expect(file()).not.toContain('Built a Playwright suite');
    expect((await cc.resumeReset(id)).message).toBe('Back to the automatic version.');
    expect(file()).toContain('Built a Playwright suite');
    expect(loadChoices(s.store, id).savedAt).toBeNull();
  });

  test('agent wording: grounded rewrites become suggestions, invented facts are thrown out', async () => {
    const s = setup();
    const id = await posting(s);
    const app = s.jh.list()[0];
    const generate = async (prompt: string) => {
      expect(prompt).toContain('Do not add numbers, tools, employers');
      return JSON.stringify({
        'w0.0': 'Built a Playwright suite for 240 checkout flows',
        'w0.1': 'Validated 50 REST API endpoints with Postman, SQL and Kubernetes',
        'w0.2': 'Cut regression time from 3 days to 2 hours with parallel CI runs',
      });
    };
    expect(await suggestWording(s.store, app, MASTER, generate)).toEqual({ accepted: 1, rejected: 2 });
    const v = await cc.resumeWorkshop(id);
    const lines = v.roles[0].lines;
    expect(lines.find((l) => l.id === 'w0.0')).toMatchObject({ suggestion: 'Built a Playwright suite for 240 checkout flows', text: 'Built a Playwright suite covering 240 checkout flows' });
    expect(lines.find((l) => l.id === 'w0.1')!.suggestion).toBeNull();
    expect(v.rejected.map((r) => r.reason).sort()).toEqual(['"Kubernetes" does not appear in your resume or the posting', 'number "2" is not in the source']);
    // A suggestion changes nothing until it is accepted.
    expect(v.previewHtml).toContain('covering 240 checkout flows');
    const accepted = await cc.saveResumeChoices(id, { bullets: { 'w0.0': { text: 'Built a Playwright suite for 240 checkout flows' } }, dropSuggestions: ['w0.0'] });
    expect(accepted.previewHtml).toContain('Built a Playwright suite for 240 checkout flows');
    expect(accepted.roles[0].lines.find((l) => l.id === 'w0.0')).toMatchObject({ suggestion: null, flag: null, edited: true });
    await expect(cc.resumeSuggest(id)).rejects.toThrow('Connect a model');
  });

  test('research: reads the posting, the public board and named pages; refuses Glassdoor', async () => {
    const s = setup();
    const id = await posting(s, { source: 'greenhouse', sourceId: 'acme:1', url: 'https://boards.greenhouse.io/acme/jobs/1' });
    await cc.saveResumeChoices(id, { notes: 'A reviewer said the team is moving to Cypress and cares about SQL.' });
    const calls: string[] = [];
    const fetchImpl: any = async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('boards-api.greenhouse.io')) {
        return { ok: true, json: async () => ({ jobs: [
          { id: 2, title: 'Senior SDET', absolute_url: 'https://boards.greenhouse.io/acme/jobs/2', content: '<p>Playwright, Kubernetes, SQL</p>', location: { name: 'Remote' } },
          { id: 3, title: 'Account Executive', absolute_url: 'https://boards.greenhouse.io/acme/jobs/3', content: '<p>Sales</p>', location: { name: 'Remote' } },
        ] }) };
      }
      return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<html><script>var Docker=1</script><body><h1>How we test</h1><p>We run Playwright in CI with Docker.</p></body></html>' };
    };
    const app = s.jh.list()[0];
    const r = await researchCompany(s.store, app, MASTER, { urls: ['https://acme.example/blog/testing', 'https://www.glassdoor.com/Reviews/acme', 'http://acme.example/x', 'https://localhost/admin'], fetchImpl, generate: async () => '["Automation in CI with Playwright", "SQL for data checks"]' });
    expect(calls.some((u) => /glassdoor|localhost|http:\/\/acme/.test(u))).toBe(false);
    expect(r.sources.map((x) => x.kind)).toEqual(['posting', 'board', 'page', 'blocked', 'blocked', 'blocked', 'notes']);
    expect(r.sources[3].detail).toMatch(/Glassdoor does not allow automated reading/);
    expect(r.otherRoles).toEqual([{ title: 'Senior SDET', url: 'https://boards.greenhouse.io/acme/jobs/2' }]);
    const playwright = r.terms.find((t) => t.term === 'playwright')!;
    expect(playwright).toMatchObject({ count: 3, onResume: true });
    expect(r.terms.find((t) => t.term === 'kubernetes')).toMatchObject({ onResume: false });
    expect(r.terms.find((t) => t.term === 'cypress')!.from).toEqual(expect.arrayContaining(['Your notes']));
    expect(r.brief).toEqual(['Automation in CI with Playwright', 'SQL for data checks']);
    expect((await cc.resumeWorkshop(id)).research?.terms.length).toBeGreaterThan(3);

    expect(pageRefusal('https://www.linkedin.com/company/acme')).toMatch(/LinkedIn/);
    expect(pageRefusal('https://192.168.1.4/')).toBe('Only public web pages are read.');
    expect(pageRefusal('https://acme.example/careers')).toBeNull();
  });

  test('what has worked: callback rate by keyword from the person\'s own applications', async () => {
    const s = setup();
    for (const [company, text, won] of [['A', 'Requirements\n- Playwright\n- SQL', true], ['B', 'Requirements\n- Playwright\n- SQL', true], ['C', 'Requirements\n- Playwright\n- Jira', false], ['D', 'Requirements\n- Jira', false]] as const) {
      const { application } = await s.jh.addPosting({ company, title: 'QA Engineer', descriptionText: text } as any);
      await s.store.setStatus(application.id, 'tailored');
      await s.store.setStatus(application.id, 'applied');
      if (won) await s.store.setStatus(application.id, 'screening');
    }
    const r = keywordOutcomes(s.store, MASTER, 2);
    expect(r.sent).toBe(4);
    expect(r.rows).toEqual([{ term: 'sql', sent: 2, callbacks: 2, rate: 100 }, { term: 'playwright', sent: 3, callbacks: 2, rate: 67 }, { term: 'jira', sent: 2, callbacks: 0, rate: 0 }]);
    expect(keywordOutcomes(s.store, MASTER).rows.map((x) => x.term)).toEqual(['playwright']);
  });
});
