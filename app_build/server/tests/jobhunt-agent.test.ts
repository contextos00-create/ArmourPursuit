'use strict';

import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as agent from '../jobhunt/agent';
import { createJobHunt } from '../jobhunt/index';
import type { SmsSender } from '../jobhunt/sms';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', email: 'sam@example.com', label: 'QA Engineer' },
  work: [{ name: 'Northwind', position: 'QA Automation Engineer', startDate: '2020-01', highlights: ['Built a Playwright suite with 600+ tests'] }],
  skills: [{ name: 'Testing', keywords: ['Playwright', 'SQL'] }],
};

function fakeSms(): SmsSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: async (b) => { sent.push(b); return { status: 'sent', providerId: null, error: null }; } };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-agent-'));
  const sms = fakeSms();
  const prefs: any = { dailyTarget: 10 };
  const jh = createJobHunt({ store: new JobHuntStore({ path: ':memory:' }), sms, mail: null, smsInbox: null, generate: null, pdf: null, outputDir: join(dir, 'docs'), masterResume: MASTER, preferences: prefs, autoTailor: false, answersPath: join(dir, 'answers.json'), connectionsPath: join(dir, 'connections.csv') });
  let saved: any = prefs;
  const io = { read: () => JSON.parse(JSON.stringify(saved)), write: (p: any) => { saved = p; } };
  return { dir, jh, sms, io, saved: () => saved };
}

const CFG: agent.AgentConfig = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test-1234' };

describe('agent actions', () => {
  test('validateAction accepts whitelisted actions and rejects the rest', () => {
    expect(agent.validateAction({ type: 'set_preference', key: 'dailyTarget', value: 15 })).toEqual({ type: 'set_preference', key: 'dailyTarget', value: 15 });
    expect(agent.validateAction({ type: 'set_preference', key: 'dailyTarget', value: 500 })).toBeNull();
    expect(agent.validateAction({ type: 'set_preference', key: 'autoSubmit', value: true })).toBeNull();
    expect(agent.validateAction({ type: 'set_preference', key: 'workModes', value: ['remote', 'moon'] })).toBeNull();
    expect(agent.validateAction({ type: 'add_watchlist', ats: 'greenhouse', slug: 'acme' })).toMatchObject({ slug: 'acme' });
    expect(agent.validateAction({ type: 'add_watchlist', ats: 'workday', slug: 'acme' })).toBeNull();
    expect(agent.validateAction({ type: 'add_posting', url: 'http://insecure.example' })).toBeNull();
    expect(agent.validateAction({ type: 'delete_everything' })).toBeNull();
  });

  test('parseReply strips the actions block and counts dropped entries', () => {
    const r = agent.parseReply('Raise the target.\n```actions\n[{"type":"set_preference","key":"dailyTarget","value":15},{"type":"set_preference","key":"autoSubmit","value":true}]\n```');
    expect(r.reply).toBe('Raise the target.');
    expect(r.actions).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(agent.parseReply('No changes.').actions).toEqual([]);
    expect(agent.parseReply('Bad\n```actions\nnot json\n```').dropped).toBe(1);
  });
});

describe('agent chat', () => {
  test('chat sends a snapshot, stores history and proposals, and nothing changes until applied', async () => {
    const { jh, io, saved } = setup();
    await jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: 'Playwright and SQL' });
    let seenSystem = '';
    const call: agent.CallModel = async (_cfg, system, messages) => {
      seenSystem = system;
      expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Raise my target' });
      return 'Go to 15 a day.\n```actions\n[{"type":"set_preference","key":"dailyTarget","value":15},{"type":"add_watchlist","ats":"lever","slug":"acme","name":"Acme"}]\n```';
    };
    const out = await agent.chat(jh, CFG, 'Raise my target', io.read(), call);
    expect(seenSystem).toContain('Acme');
    expect(seenSystem).toContain('Allowed actions');
    expect(out.reply).toBe('Go to 15 a day.');
    expect(out.proposals.map((p) => p.summary)).toEqual(['Set dailyTarget to 15', 'Watch Acme on lever']);
    expect(agent.history(jh)).toHaveLength(2);
    expect(saved().dailyTarget).toBe(10);

    expect(await agent.applyProposal(jh, out.proposals[0].id, io)).toMatch(/Done/);
    expect(saved().dailyTarget).toBe(15);
    await agent.applyProposal(jh, out.proposals[1].id, io);
    expect(saved().watchlist).toEqual([{ ats: 'lever', slug: 'acme', name: 'Acme' }]);
    expect(agent.pendingProposals(jh)).toEqual([]);
    await expect(agent.applyProposal(jh, out.proposals[0].id, io)).rejects.toThrow(/gone/);
    jh.close();
  });

  test('status and pause proposals act on the pipeline', async () => {
    const { jh, io, sms } = setup();
    const { application } = await jh.addPosting({ company: 'Globex', title: 'SDET', descriptionText: 'Playwright' });
    const code = application.id.slice(0, 6);
    const call: agent.CallModel = async () => `ok\n\`\`\`actions\n[{"type":"set_status","code":"${code}","status":"applied"},{"type":"pause"}]\n\`\`\``;
    const out = await agent.chat(jh, CFG, 'I applied to Globex, then pause', {}, call);
    await agent.applyProposal(jh, out.proposals[0].id, io);
    expect(jh.list().find((a) => a.id === application.id)?.status).toBe('applied');
    await agent.applyProposal(jh, out.proposals[1].id, io);
    expect(jh.store.getKv('paused')).toBe('1');
    expect(sms.sent.some((s) => /applied/i.test(s))).toBe(true);
    jh.close();
  });

  test('chat refuses without a model config', async () => {
    const { jh } = setup();
    await expect(agent.chat(jh, null, 'hi', {}, async () => 'x')).rejects.toThrow(/API key/);
    jh.close();
  });
});

describe('agent config', () => {
  test('saves with mode 600, hides the key, keeps the old key when blank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-cfg-'));
    const path = join(dir, 'agent.json');
    const pub = agent.saveAgentConfig(path, { provider: 'anthropic', apiKey: 'sk-ant-secret-9876' });
    expect(pub).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', hasKey: true, keyHint: '…9876' });
    expect(JSON.stringify(pub)).not.toContain('secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    agent.saveAgentConfig(path, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: null });
    expect(JSON.parse(readFileSync(path, 'utf8')).apiKey).toBe('sk-ant-secret-9876');
  });
});

describe('command center documents', () => {
  test('readDocument serves files inside the documents folder only', async () => {
    const { dir, jh } = setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cc = require('../jobhunt/command-center') as typeof import('../jobhunt/command-center');
    cc.pipeline(jh);
    mkdirSync(join(dir, 'docs', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'acme', 'cover-letter.txt'), 'Hello');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    const doc = cc.readDocument('acme/cover-letter.txt');
    expect(Buffer.from(doc.base64, 'base64').toString()).toBe('Hello');
    expect(doc.mime).toBe('text/plain');
    expect(() => cc.readDocument('../secret.txt')).toThrow(/Not a document/);
    expect(() => cc.readDocument('acme/run.sh')).toThrow(/Not a document/);
    // One-tap actions and the answer bank.
    expect(cc.saveBankAnswer('Are you authorized to work in the US?', 'Yes')).toMatch(/saved/);
    expect(cc.state().answers).toEqual([{ question: 'Are you authorized to work in the US?', answer: 'Yes' }]);
    expect(cc.saveBankAnswer('are you authorized to work in the us?', '')).toMatch(/removed/);
    expect(cc.state().answers).toEqual([]);
    expect(cc.saveSettings({ dailyTarget: 22, autoSubmit: true }).dailyTarget).toBe(22);
    const s = cc.state();
    expect(s.settings.autoSubmit).toBe(true);
    expect(s.dashboard.metrics.tracked).toBeGreaterThanOrEqual(0);
    const { application } = await jh.addPosting({ company: 'Hooli', title: 'QA Engineer', descriptionText: 'Playwright and SQL', url: 'https://example.com/hooli' });
    const row = cc.state().applications.find((a) => a.id === application.id)!;
    expect(row).toMatchObject({ company: 'Hooli', code: application.id.slice(0, 4) });
    expect(row.nextStatuses).toContain('applied');
    expect(await cc.applicationAction(application.id, 'applied')).toBeTruthy();
    expect(cc.state().applications.find((a) => a.id === application.id)!.status).toBe('applied');
    await expect(cc.applicationAction('nope', 'applied')).rejects.toThrow(/gone/);
    expect(await cc.automation('pause')).toBeTruthy();
    expect(cc.state().paused).toBe(true);
    expect(s.config.hasKey === true || s.config.hasKey === false).toBe(true);

    // Metrics, the prep zone and the LinkedIn zone.
    const m = cc.state().metrics;
    expect(m).toMatchObject({ tracked: 1, applied: 1, sentThisWeek: 1 });
    expect(m.weeks).toHaveLength(8);
    expect(m.buckets.find((b) => b.key === 'waiting')!.n).toBe(1);
    expect(cc.state().dashboard.target).toBeGreaterThan(0);
    const prep = cc.state().prep.find((p) => p.id === application.id)!;
    expect(prep.live).toBe(false);
    expect(prep.behavioral.length).toBeGreaterThan(0);
    expect(prep.covered.flatMap((c) => c.proof.map((x) => x.text))).toContain('Built a Playwright suite with 600+ tests');
    expect(cc.savePrep(application.id, { notes: { c0: 'Checkout flow regression', 'bad key!': 'x' }, practiced: [prep.behavioral[0]] })).toMatch(/saved/);
    const again = cc.state().prep.find((p) => p.id === application.id)!;
    expect(again.notes).toEqual({ c0: 'Checkout flow regression' });
    expect(again.practiced).toEqual([prep.behavioral[0]]);
    expect(() => cc.savePrep('nope', { notes: {}, practiced: [] })).toThrow(/gone/);
    expect(cc.readDocument(cc.prepDocument(application.id)).mime).toBe('text/html');

    expect(cc.state().network.connections).toBe(0);
    expect(() => cc.saveConnections('just,some,text')).toThrow(/Connections.csv/);
    expect(cc.saveConnections('Notes:\n"Export"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nDana,Lee,https://www.linkedin.com/in/danalee,,Hooli Inc,QA Lead,01 Jan 2024\nRay,Cho,javascript:alert(1),,Hooli,Engineer,01 Jan 2024\nKim,Park,https://www.linkedin.com/in/kimpark,,Initech,Recruiter,01 Jan 2024\n')).toMatch(/Imported 3/);
    const net = cc.state().network;
    expect(net).toMatchObject({ connections: 3, atTracked: 1, companiesWithPeople: 1, inQa: 1 });
    const hooli = net.rows.find((r) => r.id === application.id)!;
    expect(hooli.people.map((p) => p.name)).toEqual(['Dana Lee']);
    expect(hooli.people[0].ask).toContain('Hi Dana');
    expect(hooli.managerSearch).toContain('linkedin.com/search/results/people');
    await expect(cc.automation('inbox')).rejects.toThrow(/Email is not connected/);
    jh.close();
  });
});
