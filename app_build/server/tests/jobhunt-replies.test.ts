'use strict';

import * as cc from '../jobhunt/command-center';
import { runFollowups } from '../jobhunt/followups';
import { rawMessage } from '../jobhunt/gmail';
import { createJobHunt } from '../jobhunt/index';
import { DEFAULT_REPLY_CONFIG, followupPlan, onInboundEmail, runReplyFollowups, markDraftSent, loadDrafts, placeholders, renderTemplate, replyConfig } from '../jobhunt/responses';
import { JobHuntStore } from '../jobhunt/store';
import type { MasterResume } from '../jobhunt/types';

// Fictional sample person. Not the user's data.
const MASTER: MasterResume = {
  basics: { name: 'Sam Rivera', email: 'sam@example.com' },
  work: [{ name: 'Northwind', position: 'QA Engineer', startDate: '2021-01', highlights: ['Built a Playwright suite covering 240 checkout flows'] }],
};
const POSTING = 'Requirements\n- 3+ years of QA experience\n- Playwright or Cypress\n';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-02T15:00:00Z'); // a Monday

function setup(preferences: any = {}, withMail = true) {
  let clock = T0;
  const sms: string[] = [];
  const out: any[] = [];
  const gmailDrafts: any[] = [];
  const mail: any = withMail
    ? {
        search: async () => [], getRaw: async () => '', ownAddresses: () => ['sam@example.com'],
        createDraft: async (d: any) => { gmailDrafts.push(d); return 'd1'; },
        send: async (d: any) => { out.push(d); return { id: 'm1', messageId: '<sent-1@mail.example.com>' }; },
      }
    : null;
  const store = new JobHuntStore({ path: ':memory:', now: () => clock });
  const jh = createJobHunt({
    store, sms: { send: async (b) => { sms.push(b); return { status: 'sent', providerId: null, error: null }; } },
    mail, smsInbox: null, generate: null, pdf: null, outputDir: null, masterResume: MASTER, preferences, autoTailor: false,
  });
  cc.pipeline(jh);
  const deps = () => ({ ...jh.replyDeps, now: () => clock });
  return { jh, store, sms, out, gmailDrafts, deps, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

async function applied(s: ReturnType<typeof setup>, contact = true) {
  const { application } = await s.jh.addPosting({ company: 'Acme', title: 'QA Engineer', descriptionText: POSTING } as any);
  if (contact) s.store.upsertContact({ applicationId: application.id, name: 'Dana Lee', email: 'dana@acme.com', source: 'manual' });
  await s.store.setStatus(application.id, 'tailored');
  await s.store.setStatus(application.id, 'applied');
  await new Promise((r) => setTimeout(r, 0));
  return application.id;
}

const email = (from: string, subject: string, body: string, id = 'in-1@acme.com') =>
  [`From: ${from}`, `Subject: ${subject}`, `Message-ID: <${id}>`, 'Date: Mon, 02 Nov 2026 15:30:00 +0000', 'Content-Type: text/plain', '', body].join('\r\n');

describe('reply rules', () => {
  test('defaults, clamping, and bad input', () => {
    expect(replyConfig({})).toEqual(DEFAULT_REPLY_CONFIG);
    const c = replyConfig({ responses: { enabled: 'yes', rules: { followup: { on: false, delayHours: 999, subject: 'Hi\nthere', body: '' }, nope: { on: true } }, followup: { firstDays: 0, everyDays: 99, max: 50, weekdaysOnly: false } } });
    expect(c.enabled).toBe(true);
    expect(c.rules.followup).toMatchObject({ on: false, delayHours: 72, subject: 'Hi there', body: DEFAULT_REPLY_CONFIG.rules.followup.body });
    expect((c.rules as any).nope).toBeUndefined();
    expect(c.followup).toEqual({ firstDays: 2, everyDays: 30, max: 5, weekdaysOnly: false });
  });

  test('templates fill from real data and leave brackets for anything missing', () => {
    const body = renderTemplate('Hi {first_name},\n\nI applied to {company} {days_ago}. {proof}\n{time_line}\n{mystery}', { contactName: null, company: 'Acme', role: 'QA Engineer', me: 'Sam', proof: null, daysAgo: 12 });
    expect(body).toBe('Hi there,\n\nI applied to Acme 12 days ago.\nI am available [add two or three times that work].\n[mystery]');
    expect(placeholders(body)).toEqual(['[add two or three times that work]', '[mystery]']);
    expect(renderTemplate('{proof}', { company: 'A', role: 'B', me: 'Sam', proof: 'Built a Playwright suite covering 240 checkout flows.' })).toBe('For example, I built a Playwright suite covering 240 checkout flows.');
  });

  test('mail headers cannot be injected and long bodies stay intact', () => {
    const raw = Buffer.from(rawMessage({ to: 'a@b.com\r\nBcc: evil@x.com', subject: 'Hello\nX-Bad: 1', body: 'Line one\nLine two é' }), 'base64url').toString('utf8');
    const [head, payload] = raw.split('\r\n\r\n');
    expect(head.split('\r\n').filter((l) => /^(bcc|x-bad):/i.test(l))).toEqual([]);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('Line one\r\nLine two é');
  });
});

describe('reply queue', () => {
  test('applying drafts an intro note. Nothing is emailed until Send is pressed.', async () => {
    const s = setup();
    const id = await applied(s);
    const [d] = loadDrafts(s.store);
    expect(d).toMatchObject({ kind: 'outreach', to: 'dana@acme.com', status: 'pending', applicationId: id });
    expect(s.out).toEqual([]);
    expect(s.gmailDrafts).toEqual([]);
    expect(s.sms[s.sms.length - 1]).toMatch(/Intro note drafted for Acme\. Open Replies to review it\. Nothing is sent until you press Send\./);

    // Scheduler ticks never send, however long it runs.
    for (let i = 0; i < 5; i++) { s.tick(3 * DAY); await runFollowups({ ...s.deps(), outputDir: null }); }
    expect(s.out).toEqual([]);

    expect(await cc.replyAction(d.id, 'send', { body: `${d.body}\n\nP.S. Happy to talk any time.` })).toBe('Sent to dana@acme.com.');
    expect(s.out).toHaveLength(1);
    expect(s.out[0].body).toMatch(/P\.S\. Happy to talk any time\.$/);
    expect(loadDrafts(s.store).find((x) => x.id === d.id)).toMatchObject({ status: 'sent', edited: true });
    // The sent message id is on file, so their reply threads back to this application.
    expect(s.store.findApplicationByMessageId('sent-1@mail.example.com')?.id).toBe(id);
    await expect(cc.replyAction(d.id, 'send')).rejects.toThrow('already closed');
    expect(s.out).toHaveLength(1);
  });

  test('a person\'s interview email drafts a threaded reply; a robot\'s does not', async () => {
    const s = setup();
    const id = await applied(s);
    await onInboundEmail(s.deps(), id, 'interview', email('Dana Lee <dana@acme.com>', 'Phone screen for QA Engineer', 'Hi Sam, are you available for a call this week?'));
    const d = loadDrafts(s.store).find((x) => x.kind === 'interview')!;
    expect(d).toMatchObject({ to: 'dana@acme.com', subject: 'Re: Phone screen for QA Engineer', inReplyTo: '<in-1@acme.com>' });
    expect(d.body).toMatch(/I am available \[add two or three times that work\]\./);
    // Unfilled brackets block sending.
    await expect(cc.replyAction(d.id, 'send')).rejects.toThrow('Fill in [add two or three times that work] first.');
    expect(s.out).toEqual([]);
    expect(await cc.replyAction(d.id, 'send', { body: d.body.replace('[add two or three times that work]', 'Tuesday or Wednesday after 1 PM') })).toBe('Sent to dana@acme.com.');
    expect(s.out[0]).toMatchObject({ to: 'dana@acme.com', inReplyTo: '<in-1@acme.com>' });

    // Same email seen twice: still one draft.
    await onInboundEmail(s.deps(), id, 'interview', email('Dana Lee <dana@acme.com>', 'Phone screen for QA Engineer', 'Hi Sam'));
    expect(loadDrafts(s.store).filter((x) => x.kind === 'interview')).toHaveLength(1);

    await onInboundEmail(s.deps(), id, 'assessment', email('no-reply@greenhouse.io', 'Your assessment', 'Complete your HackerRank test', 'in-2@gh.io'));
    expect(loadDrafts(s.store).some((x) => x.kind === 'assessment')).toBe(false);
    // A rule that is off (rejection, by default) drafts nothing.
    await onInboundEmail(s.deps(), id, 'rejection', email('Dana Lee <dana@acme.com>', 'Update', 'We are not moving forward.', 'in-3@acme.com'));
    expect(loadDrafts(s.store).some((x) => x.kind === 'rejection')).toBe(false);

    const thread = cc.state().replies.threads.find((t) => t.id === id)!;
    expect(thread.items.filter((i) => i.type === 'in').map((i) => i.detail)).toEqual([
      'Hi Sam', 'Complete your HackerRank test No reply drafted: it came from an automated address.', 'We are not moving forward. No reply drafted: this rule is off.',
    ]);
    expect(thread.items.some((i) => i.type === 'out' && /Reply to an interview invite sent/.test(i.title))).toBe(true);
  });

  test('follow-ups: schedule, weekend hold, max, stop on reply, pause', async () => {
    const s = setup({ responses: { rules: { outreach: { on: false } }, followup: { firstDays: 5, everyDays: 4, max: 2, weekdaysOnly: true } } });
    const id = await applied(s, false);
    const app = () => s.jh.list().find((a) => a.id === id)!;
    const cfg = () => replyConfig(s.jh.readPreferences());
    // Applied Monday. 5 days later is Saturday, so it waits for Monday.
    const plan = followupPlan(s.store, app(), cfg(), loadDrafts(s.store));
    expect(new Date(plan.at!).getDay()).toBe(1);
    expect(plan.at).toBe(T0 + 7 * DAY);
    s.tick(6 * DAY);
    expect(await runReplyFollowups(s.deps())).toEqual([]);
    s.tick(DAY);
    expect(await runReplyFollowups(s.deps())).toEqual([`follow-up ${id.slice(0, 8)}`]);
    expect(await runReplyFollowups(s.deps())).toEqual([]);
    const first = loadDrafts(s.store)[0];
    expect(first).toMatchObject({ kind: 'followup', to: null });
    expect(followupPlan(s.store, app(), cfg(), loadDrafts(s.store)).why).toBe('A follow-up is waiting in your queue.');
    // No address on file: sending is refused with a plain reason.
    await expect(cc.replyAction(first.id, 'send')).rejects.toThrow('Add the email address to send to.');
    expect(markDraftSent(s.store, first.id, s.now()).status).toBe('done');

    s.tick(4 * DAY);
    expect(await runReplyFollowups(s.deps())).toEqual([`follow-up ${id.slice(0, 8)}`]);
    cc.replyAction(loadDrafts(s.store).find((d) => d.status === 'pending')!.id, 'dismiss');
    s.tick(30 * DAY);
    expect(await runReplyFollowups(s.deps())).toEqual([]);
    expect(followupPlan(s.store, app(), cfg(), loadDrafts(s.store)).why).toBe('All 2 follow-ups used.');

    // A fresh application: pausing and a reply both stop the schedule.
    const s2 = setup({ responses: { rules: { outreach: { on: false } } } });
    const id2 = await applied(s2, false);
    expect(cc.pauseFollowups(id2, true)).toMatch(/paused/);
    s2.tick(10 * DAY);
    expect(await runReplyFollowups(s2.deps())).toEqual([]);
    cc.pauseFollowups(id2, false);
    await s2.store.setStatus(id2, 'screening');
    expect(await runReplyFollowups(s2.deps())).toEqual([]);
    expect(cc.state().replies.threads[0].next.why).toBe('They answered, so follow-ups stopped.');
  });

  test('master switch off drafts nothing; a manual draft still works; Gmail Drafts never sends', async () => {
    const s = setup({ responses: { enabled: false } });
    const id = await applied(s);
    expect(loadDrafts(s.store)).toEqual([]);
    expect(await cc.composeReply(id, 'followup')).toBe('Follow-up drafted. It is in your queue.');
    const d = loadDrafts(s.store)[0];
    expect(await cc.replyAction(d.id, 'gmail')).toBe('Saved to your Gmail Drafts. It is not sent.');
    expect(s.gmailDrafts).toHaveLength(1);
    expect(s.out).toEqual([]);

    const off = setup({}, false);
    const id3 = await applied(off);
    const d3 = loadDrafts(off.store)[0];
    await expect(cc.replyAction(d3.id, 'send')).rejects.toThrow('Email is not connected');
    expect(cc.state().replies).toMatchObject({ canSend: false, canGmailDraft: false });
    expect(id3).toBeTruthy();
  });

  test('saving rules and previewing them', () => {
    const s = setup();
    expect(cc.saveReplyRules({ ...DEFAULT_REPLY_CONFIG, rules: { ...DEFAULT_REPLY_CONFIG.rules, followup: { on: true, delayHours: 0, subject: 'Checking in: {role}', body: 'Hi {first_name}, still keen on {company}. {me}' } }, followup: { firstDays: 10, everyDays: 6, max: 1, weekdaysOnly: false } })).toBe('Reply rules saved.');
    expect(cc.state().replies.config.followup).toEqual({ firstDays: 10, everyDays: 6, max: 1, weekdaysOnly: false });
    expect(cc.previewReply('followup', null, null)).toMatchObject({ subject: 'Checking in: QA Engineer', body: 'Hi Jordan, still keen on Example Co. Sam' });
    // Settings saved elsewhere do not wipe the reply rules.
    cc.saveSettings({ ...cc.state().settings, dailyTarget: 12 });
    expect(cc.state().replies.config.rules.followup.subject).toBe('Checking in: {role}');
    expect(cc.resetReplyRule('followup')).toMatch(/reset/);
    expect(cc.state().replies.config.rules.followup.subject).toBe('Following up: {role}');
    s.jh.close();
  });
});
