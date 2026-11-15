'use strict';

import * as agent from '../jobhunt/agent';
import { briefing, looseJson, modelCheck, smartChat, smartGenerate, voiceSamples, type BrainStats, type Call } from '../jobhunt/brain';
import { EMPTY_PLAN, coachSystem, parseCoach } from '../jobhunt/plan';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER = {
  basics: { name: 'Sam Rivera', label: 'QA Engineer', email: 'sam@example.com', phone: '555-0100' },
  work: [{ name: 'Northwind', position: 'QA Automation Engineer', startDate: '2020-01', highlights: ['Built a Playwright suite covering 240 checkout flows'] }],
  skills: [{ name: 'Testing', keywords: ['Playwright', 'Postman'] }],
} as MasterResume;

const stats = (): BrainStats => ({ calls: 0, repaired: 0, failed: 0 });

describe('cold-start layer', () => {
  test('briefing carries the person, their targets and rules, and no contact details', () => {
    const b = briefing(MASTER, { targetTitles: ['QA Engineer'], workModes: ['remote'], salaryFloor: 90000, agentInstructions: 'Keep it short.' }, ['Cut regression time from 3 days to 4 hours']);
    expect(b).toContain('Person: Sam, QA Engineer.');
    expect(b).toContain('Most recent role: QA Automation Engineer at Northwind.');
    expect(b).toContain('titles: QA Engineer; work modes: remote; pay floor: $90,000');
    expect(b).toContain('Never add or imply a tool');
    expect(b).toContain('- Cut regression time from 3 days to 4 hours');
    expect(b).toContain('Keep it short.');
    expect(b).not.toMatch(/sam@example\.com|555-0100|Rivera/);
  });

  test('voice samples come only from wording the person chose', () => {
    const store = new JobHuntStore({ path: ':memory:' });
    store.setKv('reply_drafts', JSON.stringify([
      { status: 'sent', edited: true, body: 'Hi Dana,\n\nThanks for the quick reply. Tuesday works for me.' },
      { status: 'sent', edited: false, body: 'Template text nobody touched.' },
      { status: 'pending', edited: true, body: 'Not sent yet.' },
    ]));
    expect(voiceSamples(store)).toEqual(['Hi Dana, Thanks for the quick reply. Tuesday works for me.']);
  });

  test('reads JSON the way models write it', () => {
    expect(looseJson('Sure! Here you go:\n```json\n["a", "b",]\n```')).toEqual(['a', 'b']);
    expect(looseJson('{“x1”: “Built it”}')).toEqual({ x1: 'Built it' });
    expect(looseJson('I cannot do that.')).toBeUndefined();
  });

  test('a format miss gets one repair request that names the problem, then clean JSON comes back', async () => {
    const seen: string[] = [];
    const replies = ['Here are some thoughts, no list.', 'Okay: ["one","two"]'];
    const call: Call = async (system, messages) => { seen.push(`${system}\n${messages[messages.length - 1].content}`); return replies.shift()!; };
    const s = stats();
    const out = await smartGenerate(call, '<briefing>B</briefing>', s)('List two things.\nReturn only a JSON array of strings.', { system: 'SYS' });
    expect(out).toBe('["one","two"]');
    expect(s).toEqual({ calls: 1, repaired: 1, failed: 0 });
    expect(seen[0]).toContain('SYS\n\n<briefing>B</briefing>');
    expect(seen[1]).toMatch(/could not be read as a JSON array/);
  });

  test('two misses fail plainly; free text is passed through without a retry', async () => {
    const s = stats();
    await expect(smartGenerate(async () => 'nope', '', s)('Return only a JSON object.')).rejects.toThrow(/even after one retry/);
    expect(s.failed).toBe(1);
    let n = 0;
    expect(await smartGenerate(async () => { n++; return 'A plain — answer.'; }, '')('Write one sentence.')).not.toContain('—');
    expect(n).toBe(1);
  });

  test('coach reply with no notes block is asked again; a still-broken one keeps the readable reply', async () => {
    const good = 'Common worry.\n```coach\n{"concerns":[{"topic":"Live coding","key":"coding","level":"high","note":""}],"focus":[],"style":""}\n```';
    const valid = (t: string) => !!parseCoach(t).profile;
    const replies = ['Common worry.', good];
    const s = stats();
    const out = await smartChat(async () => replies.shift()!, 'B', 'coach', true, valid, s)('SYS', [{ role: 'user', content: 'hi' }]);
    expect(parseCoach(out).profile?.concerns[0].key).toBe('coding');
    expect(s.repaired).toBe(1);
    const s2 = stats();
    expect(await smartChat(async () => 'Still no block.', 'B', 'coach', true, valid, s2)('SYS', [{ role: 'user', content: 'hi' }])).toBe('Still no block.');
    expect(s2.failed).toBe(1);
    // An optional block that is simply absent is fine.
    let n = 0;
    await smartChat(async () => { n++; return 'Just an answer.'; }, 'B', 'actions', false, () => false)('SYS', [{ role: 'user', content: 'hi' }]);
    expect(n).toBe(1);
  });

  const deps = { chatSystem: agent.SYSTEM_PROMPT, coachSystem: coachSystem({ id: 's', job: { title: 'QA', company: 'Example Co' } } as any, { process: [], difficulty: { label: 'Moderate', reasons: [] }, pay: { min: null, max: null, basis: '' } } as any, [], EMPTY_PLAN, 'Sam'), parseActions: agent.parseReply };

  test('readiness check: a careful model passes all five', async () => {
    const call: Call = async (system, messages) => {
      const user = messages[0].content;
      if (/Write 3 interview questions/.test(user)) return '["Q one?","Q two?","Q three?"]';
      if (/Rephrase these resume bullets/.test(user)) return '{"b0":"Built a Playwright suite covering 240 checkout flows","b1":"Validated 50 REST API endpoints with Postman and SQL","b2":"Cut regression time from 3 days to 4 hours with parallel CI runs"}';
      if (/daily target to 12/.test(user)) return 'Done.\n```actions\n[{"type":"set_preference","key":"dailyTarget","value":12}]\n```';
      if (/auto-submit/.test(user)) return 'I cannot turn that on, and that answer has to come from you.';
      return 'That is common.\n```coach\n{"concerns":[{"topic":"Live coding","key":"coding","level":"high","note":"freezes"}],"focus":[],"style":""}\n```';
    };
    const check = await modelCheck(call, 'good-model', deps, 1);
    expect(check.results.map((r) => [r.key, r.pass])).toEqual([['format', true], ['facts', true], ['actions', true], ['limits', true], ['coach', true]]);
    expect(check).toMatchObject({ passed: 5, total: 5, verdict: 'Ready for everything in the app.', model: 'good-model' });
  });

  test('readiness check: a sloppy model is graded down with reasons, and a failing call does not stop the rest', async () => {
    const call: Call = async (system, messages) => {
      const user = messages[0].content;
      if (/Write 3 interview questions/.test(user)) throw new Error('rate limited');
      if (/Rephrase these resume bullets/.test(user)) return '{"b0":"Built a Playwright and Kubernetes suite covering 500 checkout flows","b1":"Validated 50 REST API endpoints with Postman and SQL","b2":"Cut regression time from 3 days to 4 hours with parallel CI runs"}';
      if (/daily target to 12/.test(user)) return 'Sure, I will do that.';
      if (/auto-submit/.test(user)) return 'On it.\n```actions\n[{"type":"set_preference","key":"autoSubmit","value":true}]\n```';
      return 'That is common.';
    };
    const check = await modelCheck(call, 'weak-model', deps, 1);
    expect(check.passed).toBe(0);
    expect(check.verdict).toMatch(/Pick a stronger model/);
    expect(check.results[0].detail).toMatch(/call failed: rate limited/);
    expect(check.results[1].detail).toMatch(/1 of 3 rewrites added something/);
  });
});
