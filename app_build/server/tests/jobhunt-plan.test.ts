'use strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cc from '../jobhunt/command-center';
import { runFollowups } from '../jobhunt/followups';
import { createJobHunt } from '../jobhunt/index';
import { DRILLS, coachTurn, dueReminders, loadPlan, parseCoach, roleQuestions, savePlan } from '../jobhunt/plan';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', label: 'QA Engineer', email: 'sam@example.com', summary: 'QA engineer with 6 years in test automation.' },
  work: [
    { name: 'Northwind', position: 'QA Automation Engineer', startDate: '2020-01', highlights: ['Built a Playwright suite covering 240 checkout flows', 'Validated 50 REST API endpoints with Postman and SQL'] },
    { name: 'Contoso', position: 'QA Analyst', startDate: '2017-03', endDate: '2019-12', highlights: ['Logged and triaged defects in Jira'] },
  ],
  skills: [{ name: 'Testing', keywords: ['Playwright', 'Postman', 'SQL', 'Jira', 'API'] }],
};
const POSTING = 'Senior QA Engineer. Salary: $95,000 - $120,000.\n\nRequirements\n- 8+ years of experience\n- Playwright or Cypress\n- REST API testing with Postman\n- Kubernetes\n- Selenium\n\nNice to have\n- Docker\n\nOur process includes a take-home exercise and a final panel.';
const DAY = 86_400_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-plan-'));
  const store = new JobHuntStore({ path: ':memory:' });
  const texts: string[] = [];
  const sms = { send: async (body: string) => { texts.push(body); return { status: 'sent' as const, providerId: null, error: null }; } };
  const jh = createJobHunt({ store, sms, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: {}, autoTailor: false });
  cc.pipeline(jh);
  return { dir, jh, store, texts, sms };
}
const add = async (s: ReturnType<typeof setup>, extra: any = {}) => (await s.jh.addPosting({ company: 'Acme', title: 'Senior QA Engineer', descriptionText: POSTING, ...extra } as any)).application.id;
const edit = (v: cc.GamePlan, patch: any = {}) => ({ dates: v.dates, done: v.done, confidence: v.confidence, processNotes: v.processNotes, profile: v.profile, ...patch });

describe('game plan', () => {
  test('every built-in study guide points at an https page and has steps', () => {
    for (const d of DRILLS) {
      expect(d.url).toMatch(/^https:\/\//);
      expect(d.steps.length).toBeGreaterThan(0);
    }
  });

  test('role brief: stages, difficulty and pay each carry where they come from', async () => {
    const s = setup();
    const v = cc.gamePlan(await add(s));
    expect(v.brief.process.find((p) => p.key === 'exercise')).toMatchObject({ source: 'posting' });
    expect(v.brief.process.find((p) => p.key === 'final')).toMatchObject({ source: 'posting' });
    expect(v.brief.process.find((p) => p.key === 'screen')).toMatchObject({ source: 'typical', state: 'ahead' });
    expect(v.sourceLabels.typical).toMatch(/not specific to this company/);
    expect(v.brief.pay).toMatchObject({ min: 95000, max: 120000, source: 'posting' });
    expect(v.brief.difficulty.level).toBeGreaterThanOrEqual(3);
    expect(v.brief.difficulty.reasons.join(' ')).toMatch(/must-have skills are not on your resume/);
    expect(v.brief.difficulty.source).toMatch(/not a rating of this company/);
  });

  test('pay with no range in the posting: estimated from similar tracked postings, or left unknown', async () => {
    const s = setup();
    const id = await add(s, { descriptionText: 'Requirements\n- Playwright\n', title: 'QA Engineer' });
    expect(cc.gamePlan(id).brief.pay).toMatchObject({ min: null, source: null });
    await add(s, { company: 'B', title: 'QA Engineer', descriptionText: 'Pay: $80,000 - $100,000\n- Playwright' });
    await add(s, { company: 'C', title: 'QA Engineer', descriptionText: 'Pay: $90,000 - $110,000\n- Playwright' });
    const pay = cc.gamePlan(id).brief.pay;
    expect(pay).toMatchObject({ min: 85000, max: 105000, source: 'your-postings' });
    expect(pay.basis).toMatch(/estimate, not this company's number/);
  });

  test('skill builder: gaps only, with a bridge, steps, and an answer that claims only ticked study', async () => {
    const s = setup();
    const id = await add(s);
    let v = cc.gamePlan(id);
    const names = v.gaps.map((g) => g.term);
    expect(names).toEqual(expect.arrayContaining(['kubernetes', 'selenium', 'docker']));
    expect(names).not.toContain('playwright');
    const sel = v.gaps.find((g) => g.term === 'selenium')!;
    expect(sel.kind).toBe('must');
    expect(sel.bridge).toMatch(/You have Playwright/);
    expect(sel.url).toMatch(/^https:\/\/www\.selenium\.dev/);
    expect(sel.answer).toMatch(/I have not used Selenium/);
    expect(sel.answer).toContain('[Tick off study steps');
    v = cc.saveGamePlan(id, edit(v, { done: [sel.steps[0].id], confidence: { 'gap:selenium': 4 } }));
    const after = v.gaps.find((g) => g.term === 'selenium')!;
    expect(after.steps[0].done).toBe(true);
    expect(after.confidence).toBe(4);
    expect(after.answer).not.toContain('[Tick off');
    expect(after.answer).toContain(after.steps[0].title.charAt(0).toLowerCase() + after.steps[0].title.slice(1));
    expect(after.answer).not.toContain(after.steps[1].title.slice(1));
    // Words for the job itself are never listed as a gap.
    const generic = cc.gamePlan(await add(s, { company: 'G', descriptionText: 'Requirements\n- Test automation experience\n- Kubernetes' }));
    expect(generic.gaps.map((g) => g.term)).toEqual(['kubernetes']);
  });

  test('plan of attack: dates drive the countdown, concerns add practice, ticks persist', async () => {
    const s = setup();
    const id = await add(s);
    let v = cc.gamePlan(id);
    expect(v.attack.next).toBeNull();
    expect(v.attack.phases[0].tasks.map((t) => t.id)).toContain('set-date');
    expect(v.attack.phases.find((p) => p.key === 'build')!.tasks.map((t) => t.id)).toContain('exercise');
    v = cc.saveGamePlan(id, edit(v, {
      dates: [{ id: 'abcd1', kind: 'screen', label: '', at: Date.now() + 3 * DAY, minutes: 30, remind: [1440, 60, 7] }],
      profile: { concerns: [{ topic: 'Talking about pay', key: 'salary', level: 'high', note: '' }, { topic: 'Nerves', key: 'nerves', level: 'low', note: '' }], focus: [], style: '' },
      done: ['research', 'bogus-but-harmless'],
    }));
    expect(v.dates[0]).toMatchObject({ kind: 'screen', remind: [1440, 60], source: 'you' });
    expect(v.attack.daysOut).toBe(3);
    const first = v.attack.phases[0].tasks;
    expect(first.some((t) => t.id === 'set-date')).toBe(false);
    expect(first.filter((t) => t.id.startsWith('concern:salary')).length).toBe(2);
    expect(first.some((t) => t.id.startsWith('concern:nerves'))).toBe(false); // low worry adds nothing
    expect(first.find((t) => t.id === 'research')!.done).toBe(true);
    // Study is trimmed to fit three days at 90 minutes a day; every must-have keeps its first step.
    const build = v.attack.phases.find((p) => p.key === 'build')!;
    const study = build.tasks.filter((t) => t.id.startsWith('gap:'));
    for (const g of v.gaps.filter((x) => x.kind === 'must')) expect(study.some((t) => t.id === g.steps[0].id)).toBe(true);
    const all = v.gaps.filter((x) => x.kind === 'must').flatMap((g) => g.steps).length;
    if (study.filter((t) => !t.id.startsWith('gap:docker')).length < all) expect(build.note).toMatch(/did not fit/);
    expect(v.attack.doneCount).toBe(1);
  });

  test('a date read from an invite email shows up and cannot be edited away', async () => {
    const s = setup();
    const id = await add(s);
    const start = Date.now() + 2 * DAY;
    s.store.setKv(`interview_${id}`, JSON.stringify({ start, end: start + 45 * 60_000, location: null, source: 'ics' }));
    let v = cc.gamePlan(id);
    expect(v.dates).toEqual([expect.objectContaining({ id: 'email', source: 'email', minutes: 45 })]);
    expect(v.attack.next?.at).toBe(start);
    v = cc.saveGamePlan(id, edit(v, { dates: [] }));
    expect(v.dates.map((d) => d.id)).toEqual(['email']);
    expect(loadPlan(s.store, id).dates).toEqual([]);
  });

  test('reminders: sent once inside their window, then a thank-you draft after the call', async () => {
    const s = setup();
    const id = await add(s);
    const now = new Date(2026, 10, 16, 14, 0).getTime();
    const at = now + 60 * 60_000 - 60_000; // 59 minutes out
    savePlan(s.store, id, { ...loadPlan(s.store, id), dates: [{ id: 'abcd1', kind: 'screen', label: '', at, minutes: 30, remind: [1440, 60] }] });
    const app = s.store.listApplications();
    const due = dueReminders(s.store, app, now);
    expect(due).toHaveLength(1);
    expect(due[0].body).toMatch(/Phone screen with Acme in an hour/);
    const deps = { ...s.jh.replyDeps, sms: s.sms, now: () => now, outputDir: null };
    expect(await runFollowups(deps)).toContain(`plan reminder ${id.slice(0, 8)}`);
    expect(s.texts.filter((t) => /in an hour/.test(t))).toHaveLength(1);
    await runFollowups(deps);
    expect(s.texts.filter((t) => /in an hour/.test(t))).toHaveLength(1);
    // Morning line on the days before.
    const morning = new Date(2026, 10, 14, 9, 0).getTime();
    expect(dueReminders(s.store, app, morning).map((r) => r.body).join(' ')).toMatch(/2 days to your phone screen with Acme/);
    // After it ends, a thank-you is drafted, not sent.
    const later = await runFollowups({ ...deps, now: () => at + 40 * 60_000 });
    expect(later).toContain(`thank-you ${id.slice(0, 8)}`);
    expect(cc.state().replies.queue.some((d) => d.kind === 'thankyou' && d.applicationId === id)).toBe(true);
  });

  test('coach: the reply is shown, the hidden block reshapes the plan, bad blocks are ignored', async () => {
    const s = setup();
    const id = await add(s);
    const app = s.store.listApplications()[0];
    let seen = '';
    const call = async (system: string) => {
      seen = system;
      return 'That is a common worry. What part feels hardest?\n```coach\n{"concerns":[{"topic":"Live coding","key":"coding","level":"high","note":"freezes when watched"},{"topic":"x","key":"made-up","level":"extreme","note":""}],"focus":["Explain a flaky test fix out loud"],"style":"short drills"}\n```';
    };
    const out = await coachTurn(s.store, app, MASTER, {}, 'I freeze when someone watches me code', call);
    expect(out.reply).toBe('That is a common worry. What part feels hardest?');
    expect(out.changed).toBe(true);
    expect(seen).toMatch(/Never invent facts about this company/);
    expect(seen).toMatch(/not a therapist/);
    expect(seen).toMatch(/Kubernetes \(must\)/);
    const v = cc.gamePlan(id);
    expect(v.chat.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(v.chat[1].content).not.toContain('coach');
    expect(v.profile.concerns).toEqual([{ topic: 'Live coding', key: 'coding', level: 'high', note: 'freezes when watched' }, { topic: 'x', key: null, level: 'medium', note: '' }]);
    const first = v.attack.phases[0].tasks;
    expect(first.filter((t) => t.id.startsWith('concern:coding')).length).toBe(2);
    expect(first.some((t) => t.title === 'Explain a flaky test fix out loud')).toBe(true);
    // A second turn that mentions only one concern does not erase the first, or the person's own marks.
    cc.saveGamePlan(id, edit(cc.gamePlan(id), { profile: { ...v.profile, concerns: [...v.profile.concerns, { topic: 'Nerves on the call', key: 'nerves', level: 'high', note: '' }] } }));
    await coachTurn(s.store, app, MASTER, {}, 'also pay', async (system) => { seen = system; return 'Ok.\n```coach\n{"concerns":[{"topic":"Pay","key":"salary","level":"medium","note":""}],"focus":[],"style":""}\n```'; });
    expect(seen).toMatch(/Concerns noted so far: .*Nerves on the call \(high\)/);
    expect(cc.gamePlan(id).profile.concerns.map((c) => c.key)).toEqual(['coding', null, 'nerves', 'salary']);
    expect(cc.gamePlan(id).profile.style).toBe('short drills');
    expect(parseCoach('Hello\n```coach\n{not json}\n```')).toEqual({ reply: 'Hello', profile: null });
    expect(cc.coachClear(id).chat).toEqual([]);
    expect(cc.gamePlan(id).profile.concerns).toHaveLength(4);
    // No model connected: the chat refuses plainly, the self-check still works.
    await expect(cc.coachSend(id, 'hi')).rejects.toThrow(/No model is connected/);
    expect(v.hasModel).toBe(false);
  });

  test('model questions are stored apart from the built-in ones', async () => {
    const s = setup();
    const id = await add(s);
    const app = s.store.listApplications()[0];
    const qs = await roleQuestions(s.store, app, async () => 'Sure:\n["How would you test a Kubernetes rollout?", "", 7, "Tell me about a flaky test."]');
    expect(qs).toEqual(['How would you test a Kubernetes rollout?', 'Tell me about a flaky test.']);
    expect(cc.gamePlan(id).questions).toEqual(qs);
    await expect(roleQuestions(s.store, app, async () => '[]')).rejects.toThrow(/did not return any questions/);
  });
});
