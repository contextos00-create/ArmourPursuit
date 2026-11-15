'use strict';

/**
 * Command-center agent. The job seeker plugs in their own model key and chats
 * about the search: strategy, which postings to chase, answers to application
 * questions. The model sees a snapshot of the pipeline and may PROPOSE
 * actions; nothing changes until the person clicks Apply on a proposal.
 *
 * Providers: Anthropic (Claude, via the official SDK) or any OpenAI-compatible
 * endpoint (OpenAI, OpenRouter, Groq, a local Ollama). Config, including the
 * key, lives in data/jobhunt/agent.json, which is local runtime state and
 * never committed. The key is never sent back to the browser.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobHunt } from './index';
import { getPending } from './apply';
import { APPLICATION_STATUSES, type ApplicationStatus } from './types';

export type Provider = 'anthropic' | 'openai' | 'openai-compatible';

export interface AgentConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseURL?: string | null;
}

export interface PublicAgentConfig {
  provider: Provider;
  model: string;
  baseURL: string | null;
  hasKey: boolean;
  keyHint: string | null;
}

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: '',
  'openai-compatible': '',
};

export function loadAgentConfig(path: string): AgentConfig | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return c && c.provider ? c : null;
  } catch {
    return null;
  }
}

export function publicConfig(c: AgentConfig | null): PublicAgentConfig {
  return {
    provider: c?.provider ?? 'anthropic',
    model: c?.model || DEFAULT_MODELS[c?.provider ?? 'anthropic'],
    baseURL: c?.baseURL ?? null,
    hasKey: !!c?.apiKey,
    keyHint: c?.apiKey ? `…${c.apiKey.slice(-4)}` : null,
  };
}

export function saveAgentConfig(path: string, input: { provider: Provider; model?: string; apiKey?: string | null; baseURL?: string | null }): PublicAgentConfig {
  if (!['anthropic', 'openai', 'openai-compatible'].includes(input.provider)) throw new Error('Unknown provider.');
  const prev = loadAgentConfig(path);
  const next: AgentConfig = {
    provider: input.provider,
    model: (input.model ?? '').trim() || DEFAULT_MODELS[input.provider],
    // An empty key field keeps the saved key.
    apiKey: input.apiKey?.trim() || prev?.apiKey || '',
    baseURL: input.provider === 'openai-compatible' ? (input.baseURL ?? '').trim() || null : null,
  };
  if (next.provider === 'openai-compatible' && !next.baseURL) throw new Error('An OpenAI-compatible provider needs a base URL.');
  if (!next.model) throw new Error('Pick a model.');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return publicConfig(next);
}

// ── Model call ─────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type CallModel = (cfg: AgentConfig, system: string, messages: ChatTurn[]) => Promise<string>;

export const callModel: CallModel = async (cfg, system, messages) => {
  if (!cfg.apiKey && cfg.provider !== 'openai-compatible') throw new Error('Add an API key first.');
  if (cfg.provider === 'anthropic') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new (Anthropic.default ?? Anthropic)({ apiKey: cfg.apiKey });
    const params: any = { model: cfg.model, max_tokens: 16000, system, messages };
    const options: any = {};
    // Server-side fallback if the model declines; only on models that support it.
    if (/^claude-(opus-5-5|opus-5|fable-5-[12]|sonnet-5-5)$/.test(cfg.model)) {
      params.fallbacks = 'default';
      options.headers = { 'anthropic-beta': 'server-side-fallback-2026-07-01' };
    }
    const res: any = await client.messages.create(params, options);
    if (res.stop_reason === 'refusal') return 'The model declined to answer that. Try rephrasing the question.';
    return (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  }
  const base = cfg.provider === 'openai' ? 'https://api.openai.com/v1' : String(cfg.baseURL).replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${json.error?.message ?? 'request failed'}`);
  return String(json.choices?.[0]?.message?.content ?? '').trim();
};

// ── Actions the agent may propose ──────────────────────────────────────────

const LIST = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= 120) && v.length <= 60;
const INT = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Preference keys the agent may change, with validators. autoSubmit is deliberately absent. */
export const PREFERENCE_KEYS: Record<string, (v: unknown) => boolean> = {
  dailyTarget: INT(1, 50),
  salaryFloor: INT(0, 1_000_000),
  autoTailorAt: INT(0, 100),
  approvalAt: INT(0, 100),
  hotScore: INT(0, 100),
  seniority: (v) => ['junior', 'mid', 'senior', 'staff'].includes(String(v)),
  workModes: (v) => LIST(v) && (v as string[]).every((m) => ['remote', 'hybrid', 'onsite'].includes(m)),
  locations: LIST,
  targetTitles: LIST,
  titleKeywords: LIST,
  excludeTitleKeywords: LIST,
  blockedCompanies: LIST,
  dreamCompanies: LIST,
  'adzuna.what': LIST,
  'adzuna.where': LIST,
};

/** Preference values the agent may set (kept serializable for the page). */
export type PrefValue = string | number | boolean | string[];

export type Action =
  | { type: 'set_preference'; key: string; value: PrefValue }
  | { type: 'add_watchlist'; ats: 'greenhouse' | 'lever' | 'ashby'; slug: string; name?: string }
  | { type: 'remove_watchlist'; slug: string }
  | { type: 'approve' | 'skip' | 'mark_applied'; code: string }
  | { type: 'set_status'; code: string; status: ApplicationStatus; reason?: string }
  | { type: 'answer_question'; code: string; n: number; answer: string }
  | { type: 'save_answer'; question: string; answer: string }
  | { type: 'add_contact'; code: string; name: string; title?: string; email?: string; linkedin?: string }
  | { type: 'add_posting'; url: string }
  | { type: 'start_apply'; code: string }
  | { type: 'run_discovery' | 'pause' | 'resume' };

export interface Proposal {
  id: string;
  action: Action;
  summary: string;
}

const str = (v: unknown, max = 300) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validateAction(a: any): Action | null {
  if (!a || typeof a !== 'object') return null;
  switch (a.type) {
    case 'set_preference':
      return str(a.key, 40) && PREFERENCE_KEYS[a.key]?.(a.value) ? { type: a.type, key: a.key, value: a.value as PrefValue } : null;
    case 'add_watchlist':
      return ['greenhouse', 'lever', 'ashby'].includes(a.ats) && /^[a-z0-9-_.]{1,60}$/i.test(a.slug ?? '') ? { type: a.type, ats: a.ats, slug: a.slug, name: str(a.name, 80) ? a.name : undefined } : null;
    case 'remove_watchlist':
      return str(a.slug, 60) ? { type: a.type, slug: a.slug } : null;
    case 'approve': case 'skip': case 'mark_applied': case 'start_apply':
      return /^[0-9a-f]{4,36}$/i.test(a.code ?? '') ? { type: a.type, code: a.code } : null;
    case 'set_status':
      return /^[0-9a-f]{4,36}$/i.test(a.code ?? '') && APPLICATION_STATUSES.includes(a.status) ? { type: a.type, code: a.code, status: a.status, reason: str(a.reason, 200) ? a.reason : undefined } : null;
    case 'answer_question':
      return /^[0-9a-f]{4,36}$/i.test(a.code ?? '') && Number.isInteger(a.n) && a.n >= 1 && str(a.answer, 500) ? { type: a.type, code: a.code, n: a.n, answer: a.answer } : null;
    case 'save_answer':
      return str(a.question, 300) && str(a.answer, 500) ? { type: a.type, question: a.question, answer: a.answer } : null;
    case 'add_contact':
      return /^[0-9a-f]{4,36}$/i.test(a.code ?? '') && str(a.name, 120)
        ? { type: a.type, code: a.code, name: a.name, title: str(a.title, 120) ? a.title : undefined, email: str(a.email, 200) ? a.email : undefined, linkedin: /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(a.linkedin ?? '') ? a.linkedin : undefined }
        : null;
    case 'add_posting':
      return /^https:\/\/\S{4,500}$/.test(a.url ?? '') ? { type: a.type, url: a.url } : null;
    case 'run_discovery': case 'pause': case 'resume':
      return { type: a.type };
    default:
      return null;
  }
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'set_preference': return `Set ${a.key} to ${JSON.stringify(a.value)}`;
    case 'add_watchlist': return `Watch ${a.name ?? a.slug} on ${a.ats}`;
    case 'remove_watchlist': return `Stop watching ${a.slug}`;
    case 'approve': return `Tailor posting ${a.code}`;
    case 'skip': return `Skip posting ${a.code}`;
    case 'mark_applied': return `Mark ${a.code} as applied`;
    case 'set_status': return `Set ${a.code} to ${a.status}`;
    case 'answer_question': return `Answer question ${a.n} for ${a.code}: "${a.answer}"`;
    case 'save_answer': return `Save answer for "${a.question}": "${a.answer}"`;
    case 'add_contact': return `Add contact ${a.name} to ${a.code}`;
    case 'add_posting': return `Add posting ${a.url}`;
    case 'start_apply': return `Open and fill the application form for ${a.code} (you review and submit)`;
    case 'run_discovery': return 'Run discovery now';
    case 'pause': return 'Pause automation';
    case 'resume': return 'Resume automation';
  }
}

/** Pull the ```actions [...]``` block out of a reply. Invalid entries are dropped. */
export function parseReply(text: string): { reply: string; actions: Action[]; dropped: number } {
  const m = text.match(/```actions\s*([\s\S]*?)```/i);
  if (!m) return { reply: text.trim(), actions: [], dropped: 0 };
  let raw: any[] = [];
  try {
    const parsed = JSON.parse(m[1]);
    raw = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { reply: text.replace(m[0], '').trim(), actions: [], dropped: 1 };
  }
  const actions = raw.map(validateAction).filter(Boolean) as Action[];
  return { reply: text.replace(m[0], '').trim(), actions: actions.slice(0, 8), dropped: raw.length - actions.length };
}

// ── State snapshot for the model ───────────────────────────────────────────

export function snapshot(jh: JobHunt, prefs: unknown): string {
  const apps = jh.list();
  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  const recent = [...apps].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 25).map((a) => {
    const pending = getPending(jh.store, a.id);
    return `- ${a.id.slice(0, 4)} | ${a.job.company} | ${a.job.title} | ${a.job.location ?? ''} | fit ${a.job.fitScore ?? '?'} (${a.job.fitRoute ?? 'unscored'}) | ${a.status}${pending.length ? ` | open form questions: ${pending.map((q, i) => `${i + 1}) ${q}`).join(' ')}` : ''}`;
  });
  let insight = '';
  try {
    const i = jh.insights();
    insight = [
      `Skills gap (share of matched postings asking, resume lacks): ${i.gap.rows.slice(0, 8).map((r) => `${r.term} ${r.share}%`).join(', ') || 'not enough data'}`,
      `Posted pay: ${i.salary.rows.map((r) => `${r.group} n=${r.n} median $${r.medianMin}-$${r.medianMax}`).join('; ') || 'none listed'}`,
      `Callbacks: ${i.works.callbacks} of ${i.works.sent} sent (${i.works.rate}%). ${i.works.rows.filter((r) => r.sent >= 5).map((r) => `${r.dimension} ${r.group}: ${r.rate}% of ${r.sent}`).join('; ')}`,
    ].join('\n');
  } catch {
    insight = 'Insights unavailable (no master resume yet).';
  }
  return [
    `Today: ${new Date().toISOString().slice(0, 10)}. Automation is ${jh.store.getKv('paused') === '1' ? 'PAUSED' : 'running'}.`,
    `Status counts: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ') || 'none yet'}`,
    `Preferences: ${JSON.stringify(prefs)}`,
    insight,
    'Most recent applications (code | company | title | location | fit | status):',
    ...recent,
  ].join('\n');
}

export const SYSTEM_PROMPT = `You are the strategist in a job seeker's command center. The person is a QA engineer running an automated job search: it finds postings, scores fit, tailors a resume and cover letter per posting (never inventing experience), fills application forms for them to submit, tracks status from email, and texts them.

Help them decide where to focus, adjust the search, answer application questions, and prepare. Be direct and specific. Use the numbers in the snapshot, say when there is too little data to conclude anything, and never invent facts about the person's experience or about companies.

When a change would help, propose it as actions. Put them at the very end of your reply in one fenced block exactly like this:
\`\`\`actions
[{"type":"set_preference","key":"dailyTarget","value":15}]
\`\`\`
The person reviews each action and clicks Apply; nothing happens until then. Only propose actions they asked for or clearly agreed with, and explain each one in your reply.

Example. They write: "I keep getting senior roles I am not ready for." A good reply says what the snapshot shows in one or two sentences, proposes one change, and ends with:
\`\`\`actions
[{"type":"set_preference","key":"seniority","value":"mid"}]
\`\`\`
If nothing needs changing, leave the block out entirely. Never output an empty or partial block.

Allowed actions:
- set_preference {key, value}: keys dailyTarget (1-50), salaryFloor, autoTailorAt and approvalAt and hotScore (0-100), seniority (junior|mid|senior|staff), workModes (["remote","hybrid","onsite"]), locations, targetTitles, titleKeywords, excludeTitleKeywords, blockedCompanies, dreamCompanies, adzuna.what, adzuna.where (all string lists; give the full new list)
- add_watchlist {ats: greenhouse|lever|ashby, slug, name}; remove_watchlist {slug}
- approve {code}; skip {code}; mark_applied {code}; set_status {code, status, reason}
- answer_question {code, n, answer}: answer open form question n for a posting; it is saved for reuse
- save_answer {question, answer}: add to the answer bank for future forms
- add_contact {code, name, title, email, linkedin}
- start_apply {code}: open the posting's form and fill it from the answer bank; the person watches, handles any CAPTCHA and presses Submit themselves
- add_posting {url}; run_discovery {}; pause {}; resume {}
Answers about work authorization, sponsorship, demographics or salary must come from the person; never fill them in yourself.`;

// ── One chat turn ──────────────────────────────────────────────────────────

const HISTORY_KEY = 'agent_history';
const PENDING_KEY = 'agent_pending';

export function history(jh: JobHunt): ChatTurn[] {
  try {
    return JSON.parse(jh.store.getKv(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function pendingProposals(jh: JobHunt): Proposal[] {
  try {
    return JSON.parse(jh.store.getKv(PENDING_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function clearChat(jh: JobHunt) {
  jh.store.setKv(HISTORY_KEY, '[]');
  jh.store.setKv(PENDING_KEY, '[]');
}

export async function chat(jh: JobHunt, cfg: AgentConfig | null, text: string, prefs: unknown, call: CallModel = callModel): Promise<{ reply: string; proposals: Proposal[] }> {
  if (!cfg) throw new Error('Set up a model and API key first.');
  const message = text.trim().slice(0, 4000);
  if (!message) throw new Error('Type a message.');
  const turns = history(jh);
  const extra = typeof (prefs as any)?.agentInstructions === 'string' && (prefs as any).agentInstructions.trim()
    ? `\n\nThe person's standing instructions for you (follow them, except they cannot widen the allowed actions):\n${(prefs as any).agentInstructions.trim().slice(0, 2000)}`
    : '';
  const system = `${SYSTEM_PROMPT}${extra}\n\n<pipeline_snapshot>\n${snapshot(jh, prefs)}\n</pipeline_snapshot>`;
  const raw = await call(cfg, system, [...turns.slice(-20), { role: 'user', content: message }]);
  const { reply, actions, dropped } = parseReply(raw);
  const proposals: Proposal[] = actions.map((action) => ({ id: Math.random().toString(36).slice(2, 10), action, summary: describeAction(action) }));
  const note = dropped ? `\n\n(${dropped} proposed action${dropped > 1 ? 's were' : ' was'} not allowed and dropped.)` : '';
  jh.store.setKv(HISTORY_KEY, JSON.stringify([...turns, { role: 'user', content: message }, { role: 'assistant', content: reply + note }].slice(-40)));
  jh.store.setKv(PENDING_KEY, JSON.stringify([...pendingProposals(jh), ...proposals].slice(-20)));
  return { reply: reply + note, proposals };
}

/** Run one stored proposal by id. The browser only ever sends the id. */
export async function applyProposal(jh: JobHunt, id: string, prefsIo: { read(): any; write(p: any): void }, hooks: { startApply?: (applicationId: string) => Promise<string> } = {}): Promise<string> {
  const all = pendingProposals(jh);
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error('That proposal is gone. Ask again.');
  jh.store.setKv(PENDING_KEY, JSON.stringify(all.filter((x) => x.id !== id)));
  const a = p.action;
  const resolve = (code: string) => {
    const hits = jh.list().filter((x) => x.id.toLowerCase().startsWith(code.toLowerCase()));
    if (hits.length !== 1) throw new Error(hits.length ? `Code ${code} is ambiguous.` : `No posting ${code}.`);
    return hits[0];
  };
  switch (a.type) {
    case 'set_preference': {
      const prefs = prefsIo.read() ?? {};
      if (a.key.startsWith('adzuna.')) prefs.adzuna = { ...(prefs.adzuna ?? {}), [a.key.slice(7)]: a.value };
      else prefs[a.key] = a.value;
      prefsIo.write(prefs);
      return `${p.summary}. Done.`;
    }
    case 'add_watchlist': {
      const prefs = prefsIo.read() ?? {};
      const list = (prefs.watchlist ?? []).filter((w: any) => w.slug !== a.slug);
      prefs.watchlist = [...list, { ats: a.ats, slug: a.slug, ...(a.name ? { name: a.name } : {}) }];
      prefsIo.write(prefs);
      return `${p.summary}. Done.`;
    }
    case 'remove_watchlist': {
      const prefs = prefsIo.read() ?? {};
      prefs.watchlist = (prefs.watchlist ?? []).filter((w: any) => w.slug !== a.slug);
      prefsIo.write(prefs);
      return `${p.summary}. Done.`;
    }
    case 'approve': return jh.handleReply(`YES ${a.code}`);
    case 'skip': return jh.handleReply(`SKIP ${a.code}`);
    case 'mark_applied': return jh.handleReply(`APPLIED ${a.code}`);
    case 'set_status': {
      const app = resolve(a.code);
      await jh.setStatus(app.id, a.status, a.reason ?? 'set from command center');
      return `${app.job.company} is now ${a.status}.`;
    }
    case 'answer_question': {
      const q = jh.answerQuestion(resolve(a.code).id, a.n, a.answer);
      return `Saved answer for "${q}".`;
    }
    case 'save_answer': {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./apply').saveAnswer(jh.answersPath, a.question, a.answer);
      return `Saved answer for "${a.question}".`;
    }
    case 'add_contact': {
      const app = resolve(a.code);
      jh.addContact(app.id, { name: a.name, title: a.title ?? null, email: a.email ?? null, linkedinUrl: a.linkedin ?? null });
      return `Added ${a.name} to ${app.job.company}.`;
    }
    case 'add_posting': {
      const r = await jh.addPosting({ url: a.url });
      return `Added ${r.job.company}, ${r.job.title}${r.fit ? ` (fit ${r.fit.score})` : ''}.`;
    }
    case 'start_apply': {
      if (!hooks.startApply) throw new Error('Open the Apply tab to start a form.');
      return hooks.startApply(resolve(a.code).id);
    }
    case 'run_discovery': {
      const r = await jh.discover();
      return `Discovery: ${r.fetched} fetched, ${r.added.length} added, ${r.filteredOut} filtered.`;
    }
    case 'pause': return jh.handleReply('PAUSE');
    case 'resume': return jh.handleReply('RESUME');
  }
}

export function dismissProposal(jh: JobHunt, id: string) {
  jh.store.setKv(PENDING_KEY, JSON.stringify(pendingProposals(jh).filter((x) => x.id !== id)));
}
