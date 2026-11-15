'use strict';

/**
 * Game plan for one role: what the process probably looks like, how hard it
 * is likely to be, what it probably pays, the skills to close before the
 * interview, the dates, and a day-by-day list of what to do.
 *
 * Honesty rules for this file:
 *   - Every estimate carries its source and says it is an estimate. Nothing
 *     here is researched from sites the app is not allowed to read.
 *   - Pay comes from the posting, or from pay ranges in other postings the
 *     person tracks. No outside numbers are invented.
 *   - Difficulty is arithmetic on the posting and the resume, with the
 *     reasons listed.
 *   - Skill drills are study steps. They never put a skill on the resume.
 *   - The coach talks with the person about worries; what it learns only
 *     reorders and adds practice tasks.
 */

import { titleFamily } from './insights';
import { extractRequirements } from './requirements';
import { levelFromTitle, parseSalary, requiredYears, yearsOfExperience } from './scoring';
import type { JobHuntStore } from './store';
import { matchesTerm } from './synonyms';
import { masterText } from './tailor';
import { stripDashes } from './text';
import type { Application, ApplicationStatus, JobPosting, MasterResume } from './types';

type App = Application & { job: JobPosting };
const DAY = 86_400_000;
const MIN = 60_000;

/** Where a number or claim comes from. Shown next to it. */
export type Source = 'posting' | 'tracker' | 'your-postings' | 'your-results' | 'typical' | 'you' | 'email' | 'model';

export const SOURCE_LABEL: Record<Source, string> = {
  posting: 'From the posting',
  tracker: 'From your tracker',
  'your-postings': 'Estimate from postings you track',
  'your-results': 'From your own applications',
  typical: 'Typical for this kind of role, not specific to this company',
  you: 'You entered this',
  email: 'From their email',
  model: 'Written by the model, so check it',
};

// ── Skill families and drills ──────────────────────────────────────────────

interface Drill {
  /** Lowercase terms this drill covers. */
  terms: string[];
  name: string;
  family: string;
  /** Official documentation to start from. */
  url: string;
  steps: { title: string; minutes: number }[];
}

const D = (terms: string[], name: string, family: string, url: string, ...steps: [string, number][]): Drill => ({ terms, name, family, url, steps: steps.map(([title, minutes]) => ({ title, minutes })) });

/** Study plans for skills QA postings ask for most. Each ends with something to say in the interview. */
export const DRILLS: Drill[] = [
  D(['kubernetes', 'k8s'], 'Kubernetes', 'containers', 'https://kubernetes.io/docs/tutorials/',
    ['Read what a pod, deployment, service and namespace are', 45], ['Run a local cluster (kind or minikube) and deploy the sample app from the tutorial', 90],
    ['Do the tester moves: read pod logs, open a shell in a pod, port-forward to a service and hit it', 45], ['Write three sentences on how you would test a service running on Kubernetes', 20]),
  D(['docker', 'containers', 'containerization'], 'Docker', 'containers', 'https://docs.docker.com/get-started/',
    ['Read what images, containers and volumes are', 30], ['Run a database or app in a container and connect to it', 45],
    ['Write a Dockerfile that runs a small test suite', 60], ['Note where containers would have helped on a project you worked on', 15]),
  D(['cypress'], 'Cypress', 'browser automation', 'https://docs.cypress.io/',
    ['Read the core concepts: commands, retries, selectors', 40], ['Write three tests against a public practice site', 90],
    ['Stub one network call and assert on it', 45], ['Write down how it differs from the browser tool you already know', 20]),
  D(['playwright'], 'Playwright', 'browser automation', 'https://playwright.dev/docs/intro',
    ['Read the intro: locators, auto-waiting, fixtures', 40], ['Write three tests against a public practice site', 90],
    ['Run them in two browsers and read the trace viewer', 40], ['Write down how it differs from the browser tool you already know', 20]),
  D(['selenium', 'webdriver'], 'Selenium', 'browser automation', 'https://www.selenium.dev/documentation/',
    ['Read the WebDriver basics: locators and waits', 40], ['Write three tests with explicit waits', 90], ['Put them behind a page object', 45], ['Write down how you would keep them from being flaky', 20]),
  D(['appium', 'mobile', 'ios', 'android'], 'Mobile test automation', 'mobile testing', 'https://appium.io/docs/en/latest/',
    ['Read the Appium quickstart', 40], ['Run the sample test on an emulator', 120], ['List what is different about testing mobile versus web', 20]),
  D(['python'], 'Python', 'programming', 'https://docs.python.org/3/tutorial/',
    ['Work through data structures and functions in the tutorial', 90], ['Write a script that calls an API and checks the response', 60], ['Write five tests with pytest', 60], ['Solve two short exercises with a timer on', 60]),
  D(['java'], 'Java', 'programming', 'https://dev.java/learn/',
    ['Work through classes, collections and exceptions', 120], ['Write five JUnit tests for a small class', 60], ['Solve two short exercises with a timer on', 60]),
  D(['typescript', 'javascript'], 'TypeScript and JavaScript', 'programming', 'https://www.typescriptlang.org/docs/',
    ['Work through types, async and modules', 90], ['Write a small typed helper and tests for it', 60], ['Solve two short exercises with a timer on', 60]),
  D(['sql', 'postgres', 'postgresql', 'mysql', 'database'], 'SQL', 'data', 'https://www.postgresql.org/docs/current/tutorial.html',
    ['Practice joins, grouping and filtering', 60], ['Write the queries you would use to check what an app saved', 45], ['Write down how you set up and clean up test data', 20]),
  D(['api', 'rest', 'api testing', 'postman'], 'API testing', 'api testing', 'https://learning.postman.com/',
    ['Review methods, status codes, headers and auth', 30], ['Build a collection against a public API with assertions', 60], ['Add a negative test and a schema check', 40], ['Write down what you check beyond the status code', 15]),
  D(['graphql'], 'GraphQL', 'api testing', 'https://graphql.org/learn/',
    ['Read queries, mutations and schemas', 40], ['Send queries to a public GraphQL API and assert on the result', 60], ['List how testing it differs from REST', 15]),
  D(['github actions', 'ci', 'ci/cd', 'continuous integration'], 'CI with GitHub Actions', 'ci', 'https://docs.github.com/en/actions',
    ['Read workflows, jobs and runners', 30], ['Add a workflow that runs a test suite on every push', 60], ['Make it run in parallel and upload a report', 45], ['Write down what you do when a test fails only in CI', 15]),
  D(['jenkins'], 'Jenkins', 'ci', 'https://www.jenkins.io/doc/',
    ['Read pipelines and stages', 30], ['Run Jenkins locally and build a pipeline that runs tests', 90], ['Write down how it compares with the CI tool you know', 15]),
  D(['gitlab', 'gitlab ci'], 'GitLab CI', 'ci', 'https://docs.gitlab.com/ci/',
    ['Read pipelines, stages and jobs', 30], ['Write a .gitlab-ci.yml that runs tests', 60], ['Write down how it compares with the CI tool you know', 15]),
  D(['k6', 'load testing', 'performance', 'performance testing'], 'Load testing with k6', 'performance', 'https://grafana.com/docs/k6/latest/',
    ['Read virtual users, thresholds and checks', 30], ['Write a script that ramps load on a test API', 60], ['Decide which numbers you would report and why', 20]),
  D(['jmeter'], 'JMeter', 'performance', 'https://jmeter.apache.org/usermanual/get-started.html',
    ['Read test plans, thread groups and listeners', 30], ['Build a plan against a test API and read the report', 75], ['Decide which numbers you would report and why', 20]),
  D(['accessibility', 'a11y', 'wcag'], 'Accessibility testing', 'accessibility', 'https://www.w3.org/WAI/test-evaluate/',
    ['Read the easy checks', 30], ['Check one site with a keyboard and a screen reader', 45], ['List what automation catches and what needs a person', 15]),
  D(['security', 'security testing', 'owasp'], 'Security testing basics', 'security', 'https://owasp.org/www-project-web-security-testing-guide/',
    ['Read the top risk categories', 45], ['Pick three checks that belong in a QA pass', 30], ['Write down how you would raise a security bug', 15]),
  D(['cucumber', 'bdd', 'gherkin'], 'BDD with Cucumber', 'test design', 'https://cucumber.io/docs/',
    ['Read Gherkin and step definitions', 30], ['Write three scenarios and wire one to code', 60], ['Write down when BDD helps and when it gets in the way', 15]),
  D(['aws', 'cloud'], 'AWS basics', 'cloud', 'https://docs.aws.amazon.com/',
    ['Read what compute, storage and IAM are for', 45], ['Find where logs and metrics live for a service', 30], ['Write down how cloud hosting changes what you test', 15]),
  D(['azure'], 'Azure basics', 'cloud', 'https://learn.microsoft.com/en-us/azure/',
    ['Read the core services overview', 45], ['Find where logs and metrics live for a service', 30], ['Write down how cloud hosting changes what you test', 15]),
  D(['git'], 'Git', 'tools', 'https://git-scm.com/doc', ['Practice branch, rebase and resolving a conflict', 45], ['Open a pull request with a test change', 30]),
  D(['jira', 'agile', 'scrum'], 'Jira and agile flow', 'process', 'https://www.atlassian.com/software/jira/guides',
    ['Review how stories, bugs and sprints fit together', 20], ['Write a model bug report: steps, expected, actual, evidence', 20]),
];

const drillFor = (term: string): Drill | null => DRILLS.find((d) => d.terms.includes(term.toLowerCase())) ?? null;

export interface GapPlan {
  term: string;
  name: string;
  kind: 'must' | 'nice';
  /** The posting's own line that asks for it. */
  asks: string;
  /** A related skill the resume does show, when there is one. */
  bridge: string | null;
  url: string | null;
  steps: { id: string; title: string; minutes: number; done: boolean }[];
  minutes: number;
  /** The person's own 1 to 5 confidence, or null until they set it. */
  confidence: number | null;
  /** What to say if asked. Only claims the study steps that are ticked. */
  answer: string;
}

// ── Stored state ───────────────────────────────────────────────────────────

export interface PlanDate {
  id: string;
  kind: 'screen' | 'interview' | 'assessment' | 'other';
  label: string;
  at: number;
  minutes: number;
  /** Minutes before to send a reminder. */
  remind: number[];
}

export const CONCERN_TOPICS = [
  { key: 'gaps', label: 'A skill they want that I do not have' },
  { key: 'technical', label: 'Technical questions' },
  { key: 'coding', label: 'Live coding or a take-home' },
  { key: 'behavioral', label: 'Telling my stories well' },
  { key: 'nerves', label: 'Nerves on the call' },
  { key: 'salary', label: 'Talking about pay' },
  { key: 'history', label: 'Explaining a gap or a short job' },
  { key: 'process', label: 'Not knowing what the process looks like' },
] as const;
export type ConcernKey = (typeof CONCERN_TOPICS)[number]['key'];

export interface Concern {
  topic: string;
  /** One of the standard topics when it fits, so matching practice can be added. */
  key: ConcernKey | null;
  level: 'low' | 'medium' | 'high';
  note: string;
}

export interface CoachProfile {
  concerns: Concern[];
  /** Extra things to practice, from the conversation. */
  focus: string[];
  /** How the person wants to be prepped, in a sentence. */
  style: string;
}

export interface PlanState {
  dates: PlanDate[];
  done: string[];
  confidence: Record<string, number>;
  /** Research the person did themselves (Glassdoor reading, a friend at the company). */
  processNotes: string;
  profile: CoachProfile;
  chat: { role: 'user' | 'assistant'; content: string }[];
  /** Role-specific questions written by the model. */
  questions: string[];
}

export const EMPTY_PLAN: PlanState = { dates: [], done: [], confidence: {}, processNotes: '', profile: { concerns: [], focus: [], style: '' }, chat: [], questions: [] };
const kvKey = (id: string) => `plan_${id}`;

export function loadPlan(store: JobHuntStore, id: string): PlanState {
  try {
    const v = JSON.parse(store.getKv(kvKey(id)) ?? 'null');
    return v && typeof v === 'object' ? { ...EMPTY_PLAN, ...v, profile: { ...EMPTY_PLAN.profile, ...(v.profile ?? {}) } } : { ...EMPTY_PLAN };
  } catch {
    return { ...EMPTY_PLAN };
  }
}

export function savePlan(store: JobHuntStore, id: string, plan: PlanState) {
  store.setKv(kvKey(id), JSON.stringify(plan));
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? stripDashes(v.replace(/\r\n/g, '\n')).trim().slice(0, max) : '');
const LEVELS = ['low', 'medium', 'high'] as const;
const KINDS = ['screen', 'interview', 'assessment', 'other'] as const;
const REMIND = [10080, 2880, 1440, 120, 60, 15];

export function sanitizeProfile(input: any): CoachProfile {
  const concerns: Concern[] = (Array.isArray(input?.concerns) ? input.concerns : []).slice(0, 8).map((c: any) => {
    const key = CONCERN_TOPICS.find((t) => t.key === c?.key)?.key ?? null;
    return { topic: str(c?.topic, 80) || CONCERN_TOPICS.find((t) => t.key === key)?.label || '', key, level: LEVELS.includes(c?.level) ? c.level : 'medium', note: str(c?.note, 300) };
  }).filter((c: Concern) => c.topic);
  return { concerns, focus: (Array.isArray(input?.focus) ? input.focus : []).map((f: unknown) => str(f, 140)).filter(Boolean).slice(0, 6), style: str(input?.style, 240) };
}

/** Keep only well-formed edits from the page. Chat and model questions are not editable from here. */
export function sanitizePlan(input: unknown, stored: PlanState, now = Date.now()): PlanState {
  const i: any = input && typeof input === 'object' ? input : {};
  const dates: PlanDate[] = (Array.isArray(i.dates) ? i.dates : []).slice(0, 12).map((d: any, n: number) => ({
    id: /^[a-z0-9]{4,16}$/.test(d?.id) ? d.id : `d${now.toString(36)}${n}`,
    kind: KINDS.includes(d?.kind) ? d.kind : 'other', label: str(d?.label, 80),
    at: Number(d?.at), minutes: Math.max(10, Math.min(480, Math.round(Number(d?.minutes)) || 30)),
    remind: [...new Set((Array.isArray(d?.remind) ? d.remind : []).filter((m: unknown) => REMIND.includes(m as number)))].sort((a, b) => (b as number) - (a as number)) as number[],
  })).filter((d: PlanDate) => Number.isFinite(d.at) && d.at > 0).sort((a: PlanDate, b: PlanDate) => a.at - b.at);
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(i.confidence ?? {}).slice(0, 60)) {
    const n = Math.round(Number(v));
    if (typeof k === 'string' && k.length <= 40 && n >= 1 && n <= 5) confidence[k] = n;
  }
  return {
    dates, confidence,
    done: Array.isArray(i.done) ? [...new Set(i.done.filter((x: unknown) => typeof x === 'string' && (x as string).length <= 60))].slice(0, 300) as string[] : stored.done,
    processNotes: str(i.processNotes, 3000),
    profile: i.profile ? sanitizeProfile(i.profile) : stored.profile,
    chat: stored.chat, questions: stored.questions,
  };
}

// ── Role brief ─────────────────────────────────────────────────────────────

export interface Stage {
  key: string;
  title: string;
  detail: string;
  source: Source;
  state: 'done' | 'now' | 'ahead';
}

export interface RoleBrief {
  process: Stage[];
  processNote: string;
  difficulty: { level: 1 | 2 | 3 | 4; label: string; reasons: string[]; source: string };
  pay: { min: number; max: number; source: Source; basis: string } | { min: null; max: null; source: null; basis: string };
  /** Median days from applying to the first response, from the person's own applications. */
  responseDays: { days: number; n: number } | null;
}

const RANK: Record<string, number> = { intern: 0, junior: 1, mid: 2, senior: 3, manager: 3, staff: 4, principal: 5, director: 5, executive: 6 };
const REACHED: Record<string, ApplicationStatus[]> = {
  screen: ['screening', 'interviewing', 'offer', 'accepted'], exercise: ['interviewing', 'offer', 'accepted'], technical: ['offer', 'accepted'], final: ['offer', 'accepted'], offer: ['accepted'],
};

/** Words a posting uses for the job itself. Not a skill to study, so never listed as a gap. */
const GENERIC = new Set(['test automation', 'automation', 'testing', 'qa', 'quality assurance', 'software testing', 'automated testing']);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

export function roleBrief(store: JobHuntStore, app: App, master: MasterResume, prefs: any, now = Date.now()): RoleBrief {
  const text = app.job.descriptionText;
  const history = new Set(store.history(app.id).map((h) => h.toStatus));
  const jobLevel = levelFromTitle(app.job.title) ?? 'mid';

  // Process: stages the posting names are facts; the rest is the usual shape of a QA loop.
  const mentions = {
    exercise: /take[- ]home|coding (challenge|exercise|assessment|test)|technical assessment|skills assessment|hackerrank|codility|codesignal|live coding|pair programming/i.test(text) || history.has('assessment'),
    panel: /\bpanel\b|on-?site|final round|interview loop|virtual onsite/i.test(text),
  };
  const stages: Omit<Stage, 'state'>[] = [
    { key: 'screen', title: 'Recruiter or phone screen', detail: 'Usually 20 to 30 minutes: your background, why this role, pay expectations, logistics.', source: 'typical' },
  ];
  if (mentions.exercise) stages.push({ key: 'exercise', title: 'Assessment or take-home', detail: history.has('assessment') ? 'Your tracker shows an assessment for this role.' : 'The posting mentions a test, exercise or live coding.', source: history.has('assessment') ? 'tracker' : 'posting' });
  stages.push({ key: 'technical', title: 'Technical interview with the team', detail: 'Usually 45 to 60 minutes: how you test, your automation work, the tools in the posting.', source: 'typical' });
  if (mentions.panel || RANK[jobLevel] >= RANK.senior) stages.push({ key: 'final', title: 'Final round or panel', detail: mentions.panel ? 'The posting mentions a panel, onsite or final round.' : 'Common for senior roles: several people back to back.', source: mentions.panel ? 'posting' : 'typical' });
  stages.push({ key: 'offer', title: 'Offer and references', detail: 'Pay talk, references, start date.', source: 'typical' });
  const current = app.status === 'screening' ? 'screen' : app.status === 'assessment' ? 'exercise' : app.status === 'interviewing' ? 'technical' : app.status === 'offer' ? 'offer' : null;
  const process: Stage[] = stages.map((s) => ({ ...s, state: s.key === current ? 'now' : REACHED[s.key]?.includes(app.status) && current !== s.key ? 'done' : 'ahead' }));

  // Difficulty: points from things that can be counted.
  const reqs = extractRequirements(text, master);
  const corpus = masterText(master);
  const must = [...new Set(reqs.filter((r) => r.kind === 'must').flatMap((r) => r.keywords))].filter((k) => !GENERIC.has(k.toLowerCase()));
  const mustGaps = must.filter((k) => !matchesTerm(corpus, k));
  const myYears = Number(prefs?.yearsExperience) || yearsOfExperience(master, new Date(now));
  const wantYears = requiredYears(text);
  const myLevel = prefs?.seniority ?? levelFromTitle(master.work?.[0]?.position ?? '') ?? 'mid';
  let points = 0;
  const reasons: string[] = [];
  if (must.length) {
    const share = mustGaps.length / must.length;
    if (share > 0.4) points += 2;
    else if (share > 0.15) points += 1;
    reasons.push(mustGaps.length ? `${mustGaps.length} of ${must.length} must-have skills are not on your resume (${mustGaps.slice(0, 4).join(', ')}).` : `Your resume shows all ${must.length} must-have skills.`);
  }
  if (wantYears != null) {
    if (wantYears > myYears) points += 1;
    reasons.push(`Asks for ${wantYears}+ years. Your resume shows about ${myYears}.`);
  }
  if ((RANK[jobLevel] ?? 2) > (RANK[myLevel] ?? 2)) {
    points += 1;
    reasons.push(`The title reads as ${jobLevel} level, a step up from ${myLevel}.`);
  }
  if (/live coding|coding (challenge|interview|exercise)|algorithms?|data structures|pair programming/i.test(text)) {
    points += 1;
    reasons.push('The posting mentions a coding exercise, live coding or algorithms.');
  }
  if (mentions.exercise) {
    points += 0.5;
    reasons.push('There is an assessment or take-home step.');
  }
  if (mentions.panel) {
    points += 0.5;
    reasons.push('There is a panel or final round.');
  }
  if (reqs.length >= 10) {
    points += 0.5;
    reasons.push(`A long requirements list (${reqs.length} lines).`);
  }
  const level = (points >= 4 ? 4 : points >= 2.5 ? 3 : points >= 1 ? 2 : 1) as 1 | 2 | 3 | 4;

  // Pay: the posting if it says; otherwise similar postings on file.
  const posted = parseSalary(text);
  let pay: RoleBrief['pay'];
  if (posted) pay = { ...posted, source: 'posting', basis: 'The posting lists this range.' };
  else {
    const family = titleFamily(app.job.title);
    const similar = store.allJobs().filter((j) => j.id !== app.job.id && titleFamily(j.title) === family && (levelFromTitle(j.title) ?? 'mid') === jobLevel)
      .map((j) => parseSalary(j.descriptionText)).filter((p): p is { min: number; max: number } => !!p);
    pay = similar.length >= 2
      ? { min: median(similar.map((p) => p.min)), max: median(similar.map((p) => p.max)), source: 'your-postings', basis: `The posting lists no pay. This is the middle of ${similar.length} similar ${family} postings you track that do. It is an estimate, not this company's number.` }
      : { min: null, max: null, source: null, basis: 'The posting lists no pay, and there are not enough similar postings with pay on file to estimate from. Check Levels.fyi or Glassdoor yourself.' };
  }

  // Response time from the person's own history.
  const waits: number[] = [];
  for (const a of store.listApplications()) {
    const h = store.history(a.id);
    const sent = h.find((e) => e.toStatus === 'applied');
    const reply = h.find((e) => ['acknowledged', 'assessment', 'screening', 'interviewing', 'rejected'].includes(e.toStatus) && sent && e.createdAt > sent.createdAt);
    if (sent && reply) waits.push(Math.max(0, Math.round((reply.createdAt - sent.createdAt) / DAY)));
  }
  return {
    process,
    processNote: 'This is an outline to prepare against. The company can run it differently. Add what you learn in your notes.',
    difficulty: { level, label: ['', 'Lighter', 'Moderate', 'Demanding', 'Very demanding'][level], reasons, source: 'Worked out from this posting and your resume. It is not a rating of this company\'s interviews.' },
    pay, responseDays: waits.length >= 3 ? { days: median(waits), n: waits.length } : null,
  };
}

// ── Skill builder ──────────────────────────────────────────────────────────

export function gapPlans(app: App, master: MasterResume, plan: PlanState): GapPlan[] {
  const corpus = masterText(master);
  const seen = new Map<string, { kind: 'must' | 'nice'; asks: string }>();
  for (const r of extractRequirements(app.job.descriptionText, master)) {
    for (const k of r.keywords) {
      if (matchesTerm(corpus, k) || GENERIC.has(k.toLowerCase())) continue;
      const cur = seen.get(k);
      if (!cur || (cur.kind === 'nice' && r.kind === 'must')) seen.set(k, { kind: r.kind, asks: r.text });
    }
  }
  const out: GapPlan[] = [];
  const used = new Set<string>();
  for (const [term, info] of seen) {
    const drill = drillFor(term);
    const name = drill?.name ?? term.replace(/\b\w/g, (c) => c.toUpperCase());
    if (used.has(name)) continue; // "docker" and "containers" share one drill
    used.add(name);
    const slug = term.replace(/[^a-z0-9]+/g, '-');
    const sibling = drill ? DRILLS.filter((d) => d.family === drill.family && d !== drill).find((d) => d.terms.some((t) => matchesTerm(corpus, t))) : null;
    const baseSteps = drill?.steps ?? [
      { title: `Read the official getting-started guide for ${name}`, minutes: 45 }, { title: `Build one small thing with ${name}`, minutes: 90 }, { title: `Write three sentences on how ${name} applies to testing`, minutes: 15 },
    ];
    const steps = baseSteps.map((s, i) => ({ id: `gap:${slug}:${i}`, ...s, done: plan.done.includes(`gap:${slug}:${i}`) }));
    const did = steps.filter((s) => s.done).map((s) => s.title.charAt(0).toLowerCase() + s.title.slice(1));
    const bridge = sibling ? `You have ${sibling.name}, which is the same kind of tool (${drill!.family}).` : null;
    const answer = [
      `I have not used ${name} on the job.`,
      sibling ? `I have used ${sibling.name}, which covers the same ground.` : null,
      did.length ? `To get ready for this role I have been studying it on my own time. So far: ${did.slice(0, 3).join('; ')}.` : '[Tick off study steps above and what you did shows up here.]',
      'I pick up tools quickly, and I would be glad to walk through how I would approach it here.',
    ].filter(Boolean).join(' ');
    out.push({ term, name, kind: info.kind, asks: info.asks, bridge, url: drill?.url ?? null, steps, minutes: steps.reduce((n, s) => n + s.minutes, 0), confidence: plan.confidence[`gap:${slug}`] ?? null, answer });
  }
  return out.sort((a, b) => Number(b.kind === 'must') - Number(a.kind === 'must') || a.name.localeCompare(b.name));
}

// ── Plan of attack ─────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  minutes: number;
  /** Why this is on the list. */
  why: string;
  done: boolean;
}

export interface Phase {
  key: 'now' | 'build' | 'eve' | 'day' | 'after';
  title: string;
  when: string;
  /** Shown under the heading, for example when study was trimmed to fit. */
  note?: string;
  tasks: Task[];
}

/** Practice that answers each standard worry. */
const CONCERN_TASKS: Record<ConcernKey, [string, number][]> = {
  gaps: [['Say your honest answer for each missing skill out loud until it sounds calm', 15]],
  technical: [['Answer five likely technical questions out loud with a timer, two minutes each', 20], ['For each tool in the posting, write one sentence on how you have used it', 20]],
  coding: [['Do two timed exercises in your test language, 30 minutes each, talking through your thinking', 60], ['Set up your editor and a scratch project so nothing surprises you on the day', 15]],
  behavioral: [['Write three stories as situation, what you did, result, from real lines on your resume', 40], ['Tell each story out loud in under two minutes and record one', 20]],
  nerves: [['Do one full mock interview out loud, standing up, with a timer', 30], ['Write your first two sentences and practice them until they are automatic', 10], ['Plan the ten minutes before the call: water, notes open, one slow breath, camera check', 5]],
  salary: [['Write your number as a range, using the pay card above, and the one sentence you will say', 15], ['Practice saying it out loud three times without explaining it', 5]],
  history: [['Write a two sentence, matter-of-fact answer for the gap or short job, ending on what you did next', 15], ['Say it out loud until it takes under 20 seconds', 5]],
  process: [['Ask the recruiter what the steps are and who you will meet. It is a normal question.', 5], ['Read interview reports for this company yourself and add what you learn to your notes', 20]],
};

/** Minutes of gap study the plan schedules per day. A planning assumption, shown on the page. */
const STUDY_PER_DAY = 90;

const dateWord = (at: number) => new Date(at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const KIND_WORD: Record<PlanDate['kind'], string> = { screen: 'phone screen', interview: 'interview', assessment: 'assessment', other: 'date' };

export function attackPlan(app: App, gaps: GapPlan[], prep: { covered: number; technical: string[]; behavioral: string[] }, plan: PlanState, brief: RoleBrief, now = Date.now()): { phases: Phase[]; next: PlanDate | null; daysOut: number | null; minutes: number; doneCount: number; total: number } {
  const next = plan.dates.find((d) => d.at + d.minutes * MIN > now) ?? null;
  // Calendar days, so a 10 AM call three days from tonight reads as 3 days, not 4.
  const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const daysOut = next ? Math.max(0, Math.round((midnight(next.at) - midnight(now)) / DAY)) : null;
  const event = next ? next.label || `the ${KIND_WORD[next.kind]}` : 'the first call';
  const task = (id: string, title: string, minutes: number, why: string): Task => ({ id, title, minutes, why, done: plan.done.includes(id) });
  const high = plan.profile.concerns.filter((c) => c.level !== 'low');

  const nowTasks: Task[] = [];
  if (!plan.dates.length) nowTasks.push(task('set-date', 'Add your phone screen or interview date once you have one', 2, 'Reminders and the countdown start from it.'));
  for (const c of high) {
    for (const [i, [title, minutes]] of (c.key ? CONCERN_TASKS[c.key] : []).entries()) nowTasks.push(task(`concern:${c.key}:${i}`, title, minutes, `You said: ${c.topic.toLowerCase()}.`));
  }
  plan.profile.focus.forEach((f, i) => nowTasks.push(task(`focus:${i}:${f.slice(0, 24).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, f, 20, 'From your talk with the coach.')));
  nowTasks.push(task('research', `Read up on ${app.job.company}: what they make, who the customers are, recent news`, 20, 'So your answers and questions are about them.'));

  const build: Task[] = [];
  // Study that fits the time there is: the first step of every must-have gap, then second steps, and so on,
  // up to about 90 minutes a day. The full list stays in the skill builder.
  const musts = gaps.filter((x) => x.kind === 'must');
  const rounds = Math.max(0, ...musts.map((g) => g.steps.length));
  const budget = next ? Math.max(1, daysOut ?? 1) * STUDY_PER_DAY : 5 * STUDY_PER_DAY;
  let spent = 0;
  let leftOut = 0;
  for (let r = 0; r < rounds; r++) {
    for (const g of musts) {
      const s = g.steps[r];
      if (!s) continue;
      if (!s.done && r > 0 && spent + s.minutes > budget) { leftOut++; continue; }
      if (!s.done) spent += s.minutes;
      build.push({ id: s.id, title: `${g.name}: ${s.title}`, minutes: s.minutes, why: 'A must-have in the posting that is not on your resume.', done: s.done });
    }
  }
  build.push(task('stories', `Turn your ${prep.covered || 'best'} proof lines into short stories: situation, what you did, result`, 40, 'These are the answers they will remember.'));
  build.push(task('tech-q', `Practice the ${prep.technical.length} technical questions out loud`, Math.max(15, prep.technical.length * 3), 'Picked from the tools this posting names.'));
  build.push(task('behav-q', `Practice the ${prep.behavioral.length} behavioral questions out loud`, 20, 'Asked in almost every QA interview.'));
  if (brief.process.some((s) => s.key === 'exercise')) build.push(task('exercise', 'Do one timed practice exercise in the language or tool the posting names', 60, 'This process includes an assessment or take-home.'));
  for (const g of gaps.filter((x) => x.kind === 'nice').slice(0, 2)) build.push({ id: g.steps[0].id, title: `${g.name}: ${g.steps[0].title}`, minutes: g.steps[0].minutes, why: 'A nice-to-have in the posting. Knowing the basics is enough.', done: g.steps[0].done });

  const eve: Task[] = [
    task('questions', 'Pick three questions to ask them and write them down', 10, 'Shows you are choosing them too.'),
    task('pay', brief.pay.min != null ? `Decide your pay answer. The range to work from is $${brief.pay.min.toLocaleString()} to $${brief.pay.max.toLocaleString()}` : 'Decide your pay answer and look up a range to back it', 10, 'It often comes up on the first call.'),
    task('logistics', 'Check the link, time zone, camera, microphone and a quiet spot', 10, 'Removes the things that go wrong for no reason.'),
    task('reread', 'Reread the posting and your tailored resume once', 10, 'They will ask about what is on it.'),
  ];
  const dayOf: Task[] = [
    task('warm', 'Say your opening answer out loud once', 5, 'The first minute sets the tone.'),
    task('open', 'Have your resume, the posting and your questions open', 2, 'So you are not searching mid-call.'),
  ];
  const after: Task[] = [
    task('notes', 'Write down what they asked and anything you would answer differently', 10, 'It makes the next round easier.'),
    task('thanks', 'Send the thank-you note. A draft will be waiting under Replies.', 5, 'Fill in one specific thing you discussed first.'),
  ];
  const phases: Phase[] = [
    { key: 'now', title: 'Start here', when: 'Today', tasks: nowTasks },
    { key: 'build', title: 'Build up', note: leftOut ? `${leftOut} more study step${leftOut === 1 ? '' : 's'} did not fit in the time before ${event}, planning about ${STUDY_PER_DAY} minutes of study a day. They are in the skill builder if you have extra time. You do not need them all to do well.` : undefined, when: next ? (daysOut! > 1 ? `Over the next ${daysOut! - 1} day${daysOut === 2 ? '' : 's'}, before ${event}` : `Before ${event}`) : 'Over the next week', tasks: build },
    { key: 'eve', title: 'Day before', when: next ? dateWord(next.at - DAY) : 'The day before the call', tasks: eve },
    { key: 'day', title: 'Day of', when: next ? `${dateWord(next.at)}, ${new Date(next.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'The day of the call', tasks: dayOf },
    { key: 'after', title: 'Afterward', when: 'Same day', tasks: after },
  ];
  const all = phases.flatMap((p) => p.tasks);
  return { phases, next, daysOut, minutes: all.filter((t) => !t.done).reduce((n, t) => n + t.minutes, 0), doneCount: all.filter((t) => t.done).length, total: all.length };
}

// ── Coach ──────────────────────────────────────────────────────────────────

export function coachSystem(app: App, brief: RoleBrief, gaps: GapPlan[], plan: PlanState, me: string): string {
  return [
    `You are an interview coach talking with ${me}, a QA engineer preparing for one specific role: "${app.job.title}" at ${app.job.company}.`,
    'Your job in this chat: find out what worries them about this role or the process, answer their questions plainly, and decide what they should practice. Be warm and brief. Ask one question at a time. Use plain words. No em dashes.',
    'Rules:',
    '- Never invent facts about this company, its interviewers, its pay or its process. If you do not know, say so and say how to find out.',
    '- Never tell them to claim a skill or experience they do not have. Help them give an honest answer and close the gap by studying.',
    '- You are a coach, not a therapist. If they describe distress that goes beyond interview nerves, say kindly that it is worth talking to someone they trust or a professional, and then carry on with what you can help with.',
    '',
    'What the app knows:',
    `- Process outline: ${brief.process.map((s) => `${s.title} (${SOURCE_LABEL[s.source].toLowerCase()})`).join('; ')}.`,
    `- Difficulty estimate: ${brief.difficulty.label}. ${brief.difficulty.reasons.join(' ')}`,
    `- Pay: ${brief.pay.min != null ? `$${brief.pay.min} to $${brief.pay.max}. ${brief.pay.basis}` : brief.pay.basis}`,
    `- Skills in the posting that are not on their resume: ${gaps.map((g) => `${g.name} (${g.kind})`).join(', ') || 'none'}.`,
    `- Dates: ${plan.dates.map((d) => `${KIND_WORD[d.kind]} ${new Date(d.at).toISOString()}`).join('; ') || 'none set yet'}.`,
    plan.processNotes ? `- Their own notes on the process: ${plan.processNotes.slice(0, 800)}` : '',
    plan.profile.concerns.length ? `- Concerns noted so far: ${plan.profile.concerns.map((c) => `${c.topic} (${c.level})`).join('; ')}.` : '',
    '',
    'How a good turn looks. They say: "I have never used Kubernetes and they list it." You reply in two or three sentences: name that it is a common spot to be in, give the honest way to answer (what they have used that is close, what they are studying), and ask one question, such as how many days they have. Then the block records the concern with key "gaps".',
    '',
    'After your reply, add a fenced block exactly like this (COACH_JSON). It is read by the app, not shown to them. Include every concern you know of so far, not only new ones:',
    '```coach',
    '{"concerns":[{"topic":"short name","key":"gaps|technical|coding|behavioral|nerves|salary|history|process or null","level":"low|medium|high","note":"one sentence in their words"}],"focus":["a specific thing to practice, up to 6"],"style":"one sentence on how they want to be prepped"}',
    '```',
  ].filter((l) => l !== '').join('\n');
}

/** Split the coach's reply into what the person reads and the profile the app keeps. */
export function parseCoach(text: string): { reply: string; profile: CoachProfile | null } {
  const m = text.match(/```coach\s*([\s\S]*?)```/);
  const reply = stripDashes(text.replace(/```coach[\s\S]*?(```|$)/g, '').trim());
  if (!m) return { reply, profile: null };
  try {
    return { reply, profile: sanitizeProfile(JSON.parse(m[1])) };
  } catch {
    return { reply, profile: null };
  }
}

export type CoachCall = (system: string, messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;

export async function coachTurn(store: JobHuntStore, app: App, master: MasterResume, prefs: any, text: string, call: CoachCall): Promise<{ reply: string; changed: boolean }> {
  const plan = loadPlan(store, app.id);
  const brief = roleBrief(store, app, master, prefs);
  const gaps = gapPlans(app, master, plan);
  const chat = [...plan.chat, { role: 'user' as const, content: text.slice(0, 2000) }].slice(-30);
  const raw = await call(coachSystem(app, brief, gaps, plan, master.basics.name.split(/\s+/)[0]), chat);
  const { reply, profile } = parseCoach(raw);
  // The model adds to what the person marked themselves. It never removes their own marks.
  const same = (a: Concern, b: Concern) => (a.key && a.key === b.key) || a.topic.toLowerCase() === b.topic.toLowerCase();
  const merged: CoachProfile | null = profile && {
    concerns: [...plan.profile.concerns.filter((c) => !profile.concerns.some((n) => same(c, n))), ...profile.concerns].slice(0, 8),
    focus: [...new Set([...profile.focus, ...plan.profile.focus])].slice(0, 6),
    style: profile.style || plan.profile.style,
  };
  const next: PlanState = { ...plan, chat: [...chat, { role: 'assistant' as const, content: reply || 'I did not catch that. Could you say it another way?' }].slice(-30), profile: merged ?? plan.profile };
  savePlan(store, app.id, next);
  return { reply, changed: !!merged && JSON.stringify(merged) !== JSON.stringify(plan.profile) };
}

/** Ask the model for questions specific to this posting. Stored separately and labeled as model-written. */
export async function roleQuestions(store: JobHuntStore, app: App, generate: (prompt: string, o?: { system?: string; maxTokens?: number }) => Promise<string>): Promise<string[]> {
  const raw = await generate(
    [`Write 6 interview questions an interviewer at ${app.job.company} could ask a candidate for "${app.job.title}", based only on this posting. Mix technical and situational. Each under 30 words. No em dashes.`, 'Ask about the tools and duties this posting names, not generic ones. Do not claim to know what this company really asks.', 'Return only a JSON array of strings.', 'Example of the shape: ["How would you decide what to automate first in a checkout flow?", "Tell me about a bug that reached production and what you changed after."]', '', app.job.descriptionText.slice(0, 5000)].join('\n'),
    { system: 'You write interview practice questions from job postings.', maxTokens: 600 },
  );
  const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  const questions = (Array.isArray(parsed) ? parsed : []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 8).map((q: string) => stripDashes(q.trim()).slice(0, 240));
  if (!questions.length) throw new Error('The model did not return any questions. Try again.');
  savePlan(store, app.id, { ...loadPlan(store, app.id), questions });
  return questions;
}

// ── Reminders ──────────────────────────────────────────────────────────────

const AHEAD: Record<number, string> = { 10080: 'in a week', 2880: 'in two days', 1440: 'tomorrow', 120: 'in two hours', 60: 'in an hour', 15: 'in 15 minutes' };

/**
 * Texts that are due: reminders ahead of each date, and one morning line on
 * the days leading up to it. Returns what to send; the caller sends and logs.
 */
export function dueReminders(store: JobHuntStore, apps: App[], now = Date.now()): { applicationId: string; body: string; key: string }[] {
  const out: { applicationId: string; body: string; key: string }[] = [];
  for (const app of apps) {
    const raw = store.getKv(kvKey(app.id));
    if (!raw || raw === 'null') continue;
    const plan = loadPlan(store, app.id);
    const code = app.id.slice(0, 4);
    for (const d of plan.dates) {
      if (d.at <= now) continue;
      const what = d.label || `${KIND_WORD[d.kind].charAt(0).toUpperCase()}${KIND_WORD[d.kind].slice(1)}`;
      const time = new Date(d.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      for (const m of d.remind) {
        const key = `plan_rem_${app.id}_${d.id}_${d.at}_${m}`;
        // Inside the window for this reminder, and not past the next closer one.
        if (now >= d.at - m * MIN && now < d.at - m * MIN + Math.min(m * MIN * 0.5, 6 * 3_600_000) && !store.getKv(key)) {
          out.push({ applicationId: app.id, key, body: `[Job ${code}] ${what} with ${app.job.company} ${AHEAD[m] ?? 'soon'} (${time}). Your game plan is under Prep.` });
        }
      }
    }
    const next = plan.dates.find((d) => d.at > now);
    const local = new Date(now);
    if (next && next.at - now < 7 * DAY && next.at - now > 12 * 3_600_000 && local.getHours() >= 8 && local.getHours() < 11) {
      const key = `plan_day_${app.id}_${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`;
      if (!store.getKv(key)) {
        const days = Math.max(1, Math.round((new Date(next.at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY));
        out.push({ applicationId: app.id, key, body: `[Job ${code}] ${days} day${days === 1 ? '' : 's'} to your ${KIND_WORD[next.kind]} with ${app.job.company}. Open Prep for today's list.` });
      }
    }
  }
  return out;
}
