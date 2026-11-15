'use strict';

/**
 * Interview prep pack, written when an application reaches screening or
 * interviewing. Built only from the posting and the master resume:
 *   - each requirement, with the resume bullets that prove it (verbatim) as
 *     STAR story seeds, and the requirements the resume does not cover
 *   - likely technical questions keyed to the skills the posting names
 *   - behavioral questions and questions to ask them
 * It never writes a story for the candidate. It shows which real bullet to
 * tell and asks the candidate to fill in the situation and result.
 */

import { extractRequirements } from './requirements';
import { parseSalary } from './scoring';
import { matchesTerm } from './synonyms';
import { escapeHtml } from './text';
import type { JobPosting, MasterResume } from './types';

interface Evidence {
  text: string;
  where: string;
}

function evidence(master: MasterResume): Evidence[] {
  const out: Evidence[] = [];
  for (const w of master.work ?? []) for (const h of w.highlights ?? []) out.push({ text: h, where: `${w.position}, ${w.name}` });
  for (const p of master.projects ?? []) for (const h of p.highlights ?? []) out.push({ text: h, where: `Project: ${p.name}` });
  return out;
}

/** Technical questions QA interviewers commonly ask, keyed by the skill that triggers them. */
const TECH_QUESTIONS: [RegExp, string[]][] = [
  [/playwright|cypress|selenium|webdriver|ui automation|e2e|end-to-end/, ['How do you keep UI tests from being flaky?', 'How do you decide what belongs in an end-to-end test versus a lower-level test?', 'Walk through how you structure page objects or test fixtures.']],
  [/api|rest|postman|graphql|soap/, ['How would you test a new REST endpoint from scratch?', 'What do you check beyond the status code in an API response?']],
  [/ci|cd|github actions|jenkins|gitlab|pipeline/, ['How do you run tests in CI so they give fast, trustworthy feedback?', 'What do you do when a test fails only in CI?']],
  [/sql|database|postgres|mysql|data/, ['How do you use SQL to verify what the application wrote?', 'How do you set up and clean up test data?']],
  [/performance|load|jmeter|k6|gatling/, ['How would you plan a load test, and which numbers would you report?']],
  [/mobile|ios|android|appium/, ['What is different about testing mobile apps compared with web apps?']],
  [/accessib|wcag|a11y/, ['How do you test accessibility, and what can automation catch versus a manual check?']],
  [/security|owasp|penetration/, ['Which security checks belong in a QA process?']],
  [/agile|scrum|kanban|jira/, ['Where does QA fit in your sprint, and how early do you get involved in a story?']],
  [/javascript|typescript|python|java|c#/, ['Which language do you write tests in, and how do you keep test code maintainable?']],
  [/test plan|test strategy|test case|manual/, ['How do you write a test plan for a feature with vague requirements?', 'How do you decide what not to test?']],
];

const BEHAVIORAL = [
  'Tell me about a bug you found that others missed. How did you find it?',
  'Tell me about a time you disagreed with a developer about whether something was a bug.',
  'Tell me about a time a release went out with a problem. What did you change afterward?',
  'How do you prioritize testing when there is not enough time to test everything?',
];

const ASK_THEM = [
  'How many QA engineers are there relative to developers, and who owns test automation?',
  'What does the current test suite look like, and how long does it take to run in CI?',
  'What would a great first 90 days look like in this role?',
  'What is the biggest quality problem the team is dealing with right now?',
  'How do bugs found in production get handled and fed back into testing?',
];

export interface PrepPack {
  markdown: string;
  html: string;
  covered: { requirement: string; proof: Evidence[] }[];
  uncovered: string[];
  technical: string[];
  behavioral: string[];
  askThem: string[];
}

export function buildPrepPack(master: MasterResume, job: JobPosting): PrepPack {
  const bank = evidence(master);
  const reqs = extractRequirements(job.descriptionText, master).filter((r) => r.kind === 'must' && r.keywords.length).slice(0, 12);
  const covered: PrepPack['covered'] = [];
  const uncovered: string[] = [];
  for (const r of reqs) {
    const proof = bank.filter((b) => r.keywords.some((k) => matchesTerm(b.text, k))).slice(0, 2);
    if (proof.length) covered.push({ requirement: r.text, proof });
    else uncovered.push(r.text);
  }
  const allKeywords = reqs.flatMap((r) => r.keywords).join(' ');
  const tech = TECH_QUESTIONS.filter(([re]) => re.test(allKeywords.toLowerCase())).flatMap(([, qs]) => qs).slice(0, 10);
  const pay = parseSalary(job.descriptionText);

  const md: string[] = [`# Interview prep: ${job.company}, ${job.title}`, ''];
  md.push(`${[job.location, pay ? `posted pay $${pay.min.toLocaleString()} to $${pay.max.toLocaleString()}` : null, job.url].filter(Boolean).join(' · ')}`, '');
  md.push('## Your proof for each requirement', '', 'Tell each of these as a story: the situation, what you did, and the result. Only use details that really happened.', '');
  for (const c of covered) {
    md.push(`**${c.requirement}**`);
    for (const p of c.proof) md.push(`- "${p.text}" (${p.where})`);
    md.push('  - Situation: ___  Result: ___', '');
  }
  if (uncovered.length) {
    md.push('## Requirements your resume does not show', '', 'Have an honest answer ready: related experience, or how you would ramp up.', '');
    for (const u of uncovered) md.push(`- ${u}`);
    md.push('');
  }
  md.push('## Likely technical questions', '', ...(tech.length ? tech : ['Walk through how you would test a feature from requirements to release.']).map((q) => `- ${q}`), '');
  md.push('## Behavioral questions', '', ...BEHAVIORAL.map((q) => `- ${q}`), '');
  md.push('## Questions to ask them', '', ...ASK_THEM.map((q) => `- ${q}`), '');
  const markdown = md.join('\n');

  const li = (xs: string[]) => `<ul>${xs.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prep: ${escapeHtml(job.company)}</title>
<style>
:root{--bg:#ffffff;--fg:#0d1411;--muted:#5c6862;--card:#ffffff;--line:#e3e9e5;--accent:#0b7a4b}
@media (prefers-color-scheme:dark){:root{--bg:#0a0f0c;--fg:#eef4f0;--muted:#93a09a;--card:#101713;--line:#202b25;--accent:#3ddc97}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.meta,.hint{color:var(--muted);font-size:13px}.req{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.req b{display:block;margin-bottom:6px}.req q{display:block;margin:4px 0;color:var(--fg)}.req small{color:var(--muted)}a{color:var(--accent)}
</style></head><body><main>
<h1>${escapeHtml(job.company)}, ${escapeHtml(job.title)}</h1>
<p class="meta">${escapeHtml([job.location, pay ? `Posted pay $${pay.min.toLocaleString()} to $${pay.max.toLocaleString()}` : null].filter(Boolean).join(' · '))}${job.url ? ` · <a href="${escapeHtml(job.url)}">Posting</a>` : ''}</p>
<h2>Your proof for each requirement</h2><p class="hint">Tell each as a story: the situation, what you did, the result. Only details that really happened.</p>
${covered.map((c) => `<div class="req"><b>${escapeHtml(c.requirement)}</b>${c.proof.map((p) => `<q>${escapeHtml(p.text)}</q><small>${escapeHtml(p.where)}</small>`).join('')}</div>`).join('')}
${uncovered.length ? `<h2>Not shown on your resume</h2><p class="hint">Have an honest answer: related experience, or how you would ramp up.</p>${li(uncovered)}` : ''}
<h2>Likely technical questions</h2>${li(tech.length ? tech : ['Walk through how you would test a feature from requirements to release.'])}
<h2>Behavioral questions</h2>${li(BEHAVIORAL)}
<h2>Questions to ask them</h2>${li(ASK_THEM)}
</main></body></html>`;
  return { markdown, html, covered, uncovered, technical: tech.length ? tech : ['Walk through how you would test a feature from requirements to release.'], behavioral: BEHAVIORAL, askThem: ASK_THEM };
}
