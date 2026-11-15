import { useEffect, useState } from "react"
import {
  runModelCheck,
  saveAgentSettings,
  saveBankAnswer,
  saveJobSettings,
  setPhonePasscode,
} from "./jobhunt.functions"
import type { CommandCenterState, Tab } from "./CommandCenter"
import { MissionControl } from "./MissionControl"
import { NotifySettings } from "./NotifyPanel"
import { Lever, Switch } from "./ui"

type Settings = CommandCenterState["settings"]
type Provider = "anthropic" | "openai" | "openai-compatible"

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  "openai-compatible": "Other (OpenAI-compatible URL)",
}

/** A list of short text values shown as removable chips. */
function ChipList({ label, hint, values, onChange, placeholder }: { label: string; hint?: string; values: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const parts = draft.split(",").map((p) => p.trim()).filter(Boolean)
    if (parts.length) onChange([...new Set([...values, ...parts])])
    setDraft("")
  }
  return (
    <div className="cc-field">
      <span className="cc-label">{label}</span>
      {hint && <span className="cc-hint">{hint}</span>}
      <div className="cc-chips">
        {values.map((v) => (
          <span key={v} className="cc-tag">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        <input
          value={draft}
          aria-label={`Add to ${label}`}
          placeholder={placeholder ?? "Type and press Enter"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
    </div>
  )
}

/** A number setting. Short ranges get a slider; long ones stay a plain number box. */
function Num({ label, hint, value, min, max, step, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  if ((max - min) / (step ?? 1) <= 240) return <Lever label={label} hint={hint} value={value} min={min} max={max} step={step} onChange={onChange} />
  return (
    <label className="cc-field">
      <span className="cc-label">{label}</span>
      {hint && <span className="cc-hint">{hint}</span>}
      <input type="number" inputMode="numeric" value={value} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

const Toggle = Switch

function Section({ title, summary, children, open }: { title: string; summary: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="cc-section" open={open}>
      <summary>
        <span className="cc-section-title">{title}</span>
        <span className="cc-hint">{summary}</span>
      </summary>
      <div className="cc-section-body">{children}</div>
    </details>
  )
}

export function ControlsPanel({ state, onNotice, onChanged, onGo, onSetup }: { state: CommandCenterState; onNotice: (msg: string) => void; onChanged: () => Promise<void>; onGo: (tab: Tab) => void; onSetup: () => void }) {
  const [s, setS] = useState<Settings>(state.settings)
  const [saving, setSaving] = useState(false)
  const saved = JSON.stringify(state.settings)
  const dirty = JSON.stringify(s) !== saved

  // Pick up changes made elsewhere (the agent, another device) unless there are local edits.
  const [base, setBase] = useState(saved)
  useEffect(() => {
    if (saved === base) return
    if (JSON.stringify(s) === base) setS(state.settings)
    setBase(saved)
  }, [saved])

  const set = <TKey extends keyof Settings>(key: TKey, value: Settings[TKey]) => setS((cur) => ({ ...cur, [key]: value }))

  async function save() {
    setSaving(true)
    try {
      const next = await saveJobSettings({ data: s })
      setS(next)
      onNotice("Settings saved.")
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** A switch or lever on the control surface: saved straight away, on top of what is already saved. */
  async function quick<TKey extends keyof Settings>(key: TKey, value: Settings[TKey]) {
    set(key, value)
    try {
      await saveJobSettings({ data: { ...state.settings, [key]: value } })
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    }
  }

  return (
    <div className="cc-controls">
      <MissionControl state={state} settings={s} onQuick={quick} onNotice={onNotice} onChanged={onChanged} onGo={onGo} />
      <h2 className="cc-controls-h">All settings</h2>
      <Section title="What to look for" summary="Titles, level, pay, location">
        <ChipList label="Target titles" hint="The roles you want. Used for scoring fit." values={s.targetTitles} onChange={(v) => set("targetTitles", v)} placeholder="QA Engineer, SDET" />
        <ChipList label="Title must contain" hint="Leave empty to use the built-in QA list." values={s.titleKeywords} onChange={(v) => set("titleKeywords", v)} />
        <ChipList label="Skip titles containing" hint="Leave empty to use the built-in skip list (intern, director, hardware and so on)." values={s.excludeTitleKeywords} onChange={(v) => set("excludeTitleKeywords", v)} />
        <div className="cc-row">
          <label className="cc-field">
            <span className="cc-label">Your level</span>
            <select value={s.seniority} onChange={(e) => set("seniority", e.target.value as Settings["seniority"])}>
              <option value="">From your resume</option>
              <option value="junior">Junior</option>
              <option value="mid">Mid</option>
              <option value="senior">Senior</option>
              <option value="staff">Staff</option>
            </select>
          </label>
          <Num label="Pay floor (USD a year)" hint="0 means no floor." value={s.salaryFloor} min={0} max={1000000} step={1000} onChange={(n) => set("salaryFloor", n)} />
        </div>
        <fieldset className="cc-field">
          <legend className="cc-label">Work modes</legend>
          <span className="cc-hint">None ticked means any.</span>
          <div className="cc-checks">
            {(["remote", "hybrid", "onsite"] as const).map((m) => (
              <label key={m}>
                <input type="checkbox" checked={s.workModes.includes(m)} onChange={(e) => set("workModes", e.target.checked ? [...s.workModes, m] : s.workModes.filter((x) => x !== m))} /> {m}
              </label>
            ))}
          </div>
        </fieldset>
        <ChipList label="Places you can work on site" hint="Cities or regions for hybrid and on-site roles." values={s.locations} onChange={(v) => set("locations", v)} placeholder="Cincinnati" />
        <Toggle label="United States only" checked={s.usOnly} onChange={(b) => set("usOnly", b)} />
        <Toggle label="I need visa sponsorship" hint="Postings that say they do not sponsor are filtered out." checked={s.needsSponsorship} onChange={(b) => set("needsSponsorship", b)} />
      </Section>

      <Section title="Companies" summary={`${s.watchlist.length} watched, ${s.dreamCompanies.length} dream, ${s.blockedCompanies.length} blocked`}>
        <ChipList label="Dream companies" hint="Always sent to you for a decision, even at a lower fit." values={s.dreamCompanies} onChange={(v) => set("dreamCompanies", v)} />
        <ChipList label="Blocked companies" hint="Never tracked." values={s.blockedCompanies} onChange={(v) => set("blockedCompanies", v)} />
        <Watchlist values={s.watchlist} onChange={(v) => set("watchlist", v)} />
      </Section>

      <Section title="Job board search" summary={s.adzunaWhat.length ? `${s.adzunaWhat.length} searches` : "Off"}>
        <ChipList label="Search phrases" hint="Each phrase is one search on Adzuna. Empty turns this source off. Needs an Adzuna key on the computer." values={s.adzunaWhat} onChange={(v) => set("adzunaWhat", v)} placeholder="qa engineer" />
        <ChipList label="Search places" values={s.adzunaWhere} onChange={(v) => set("adzunaWhere", v)} placeholder="Cincinnati, remote" />
        <Num label="Newest postings only (days old)" value={s.adzunaMaxDaysOld} min={1} max={60} onChange={(n) => set("adzunaMaxDaysOld", n)} />
      </Section>

      <Section title="Volume and scoring" summary={`${s.dailyTarget} a day, tailor at ${s.autoTailorAt}+`}>
        <div className="cc-row">
          <Num label="New postings a day" value={s.dailyTarget} min={1} max={50} onChange={(n) => set("dailyTarget", n)} />
          <Num label="Tailor automatically at fit" hint="0 to 100." value={s.autoTailorAt} min={0} max={100} onChange={(n) => set("autoTailorAt", n)} />
        </div>
        <div className="cc-row">
          <Num label="Ask me first at fit" hint="Below this, postings are filtered out." value={s.approvalAt} min={0} max={100} onChange={(n) => set("approvalAt", n)} />
          <Num label="Top match at fit" hint="Texted right away." value={s.hotScore} min={0} max={100} onChange={(n) => set("hotScore", n)} />
        </div>
        <Num label="Extra top matches a day" hint="How many top matches may go over the daily number." value={s.hotExtra} min={0} max={20} onChange={(n) => set("hotExtra", n)} />
      </Section>

      <Section title="Applying" summary={s.autoSubmit ? "Auto-submit ON" : "You press Submit"}>
        <div className="cc-row">
          <Num label="Applications per company (30 days)" value={s.perCompany} min={1} max={20} onChange={(n) => set("perCompany", n)} />
          <Num label="Pause a site after failed runs" value={s.maxSiteFailures} min={1} max={20} onChange={(n) => set("maxSiteFailures", n)} />
        </div>
        <div className="cc-row">
          <Num label="Wait for you to submit (minutes)" value={s.applyWaitMinutes} min={1} max={180} onChange={(n) => set("applyWaitMinutes", n)} />
          <label className="cc-field">
            <span className="cc-label">Browser window on the computer</span>
            <select value={s.applyWindow} onChange={(e) => set("applyWindow", e.target.value as Settings["applyWindow"])}>
              <option value="auto">Show it when there is a screen</option>
              <option value="visible">Always show it</option>
              <option value="hidden">Keep it hidden, watch here</option>
            </select>
          </label>
        </div>
        <Toggle
          label="Submit automatically"
          hint="Off by default. When on, a form is submitted without you only if every required field is filled and there is no CAPTCHA. Leave off until your answer bank is complete."
          checked={s.autoSubmit}
          onChange={(b) => set("autoSubmit", b)}
        />
      </Section>

      <Section title="Schedule" summary={`Search every ${s.discoveryEveryMinutes} min, ${s.activeStart}:00 to ${s.activeEnd}:00`}>
        <span className="cc-hint">Used by the background runner on the computer.</span>
        <div className="cc-row">
          <Num label="Look for postings every (minutes)" value={s.discoveryEveryMinutes} min={15} max={1440} step={5} onChange={(n) => set("discoveryEveryMinutes", n)} />
          <Num label="Check email every (minutes)" value={s.inboxEveryMinutes} min={1} max={240} onChange={(n) => set("inboxEveryMinutes", n)} />
        </div>
        <div className="cc-row">
          <Num label="Search from (hour, 0 to 23)" value={s.activeStart} min={0} max={23} onChange={(n) => set("activeStart", n)} />
          <Num label="Search until (hour, 1 to 24)" value={s.activeEnd} min={1} max={24} onChange={(n) => set("activeEnd", n)} />
        </div>
      </Section>

      <Section title="Notifications" summary={!s.notifyEnabled ? "Off" : `${state.notify.categories.length - s.notifyOff.length} of ${state.notify.categories.length} kinds on${s.quietEnabled ? ", quiet hours on" : ""}`}>
        <NotifySettings state={state} s={s} set={set} onNotice={onNotice} />
      </Section>

      <Section title="Agent" summary={state.config.hasKey ? `${state.config.model}` : "No model yet"}>
        <label className="cc-field">
          <span className="cc-label">Standing instructions for your agent</span>
          <span className="cc-hint">How you want it to think and talk. It still cannot do more than suggest the allowed changes.</span>
          <textarea rows={4} maxLength={2000} value={s.agentInstructions} onChange={(e) => set("agentInstructions", e.target.value)} placeholder="Example: prioritize remote roles at companies under 500 people, and keep answers short." />
        </label>
        {state.local ? <ModelSettings config={state.config} onNotice={onNotice} onChanged={onChanged} /> : <p className="cc-hint">The model and its key can only be changed on the computer itself.</p>}
        <ModelCheck state={state} onNotice={onNotice} onChanged={onChanged} />
      </Section>

      <Section title="Install as an app" summary="iPhone, Android, Windows, Mac">
        <InstallApp onNotice={onNotice} />
      </Section>

      <Section title="Answer bank" summary={`${state.answers.length} saved answers`}>
        <AnswerBank answers={state.answers} onNotice={onNotice} onChanged={onChanged} />
      </Section>

      <Section title="Setup" summary={state.setup.checks.filter((c) => c.ok).length + " of " + state.setup.checks.length + " ready"}>
        <ul className="cc-checklist">
          {state.setup.checks.map((c) => (
            <li key={c.key} className={c.ok ? "cc-check-ok" : c.required ? "cc-check-need" : "cc-check-skip"}>
              <span className="cc-check-mark" aria-hidden="true">{c.ok ? "✓" : c.required ? "!" : "–"}</span>
              <span><strong>{c.label}</strong> <span className="cc-hint cc-inline">{c.ok ? "Ready" : c.required ? "Needed" : "Not set up"}</span><span className="cc-hint">{c.hint}</span></span>
            </li>
          ))}
        </ul>
        <div><button type="button" className="cc-ghost" onClick={onSetup}>Run setup again</button></div>
      </Section>

      <Section title="Phone access" summary={state.remote.enabled ? `On, ${state.remote.devices} device${state.remote.devices === 1 ? "" : "s"} signed in` : "Off"}>
        {state.local ? <PhoneAccess remote={state.remote} onNotice={onNotice} onChanged={onChanged} /> : <p className="cc-hint">Phone access can only be changed on the computer itself.</p>}
      </Section>

      {dirty && (
        <div className="cc-savebar" role="region" aria-label="Unsaved settings">
          <span>Unsaved changes</span>
          <span className="cc-savebar-actions">
            <button type="button" className="cc-ghost" disabled={saving} onClick={() => setS(state.settings)}>Discard</button>
            <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button>
          </span>
        </div>
      )}
    </div>
  )
}

function Watchlist({ values, onChange }: { values: Settings["watchlist"]; onChange: (v: Settings["watchlist"]) => void }) {
  const [ats, setAts] = useState<Settings["watchlist"][number]["ats"]>("greenhouse")
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const valid = /^[a-z0-9-_.]{1,60}$/i.test(slug.trim())
  return (
    <div className="cc-field">
      <span className="cc-label">Company watchlist</span>
      <span className="cc-hint">Career boards checked on every search. The slug is the company part of the board address, for example "acme" in boards.greenhouse.io/acme.</span>
      {values.length > 0 && (
        <ul className="cc-list">
          {values.map((w) => (
            <li key={`${w.ats}:${w.slug}`}>
              <span>{w.name || w.slug} <span className="cc-hint cc-inline">{w.ats} / {w.slug}</span></span>
              <button type="button" className="cc-ghost cc-small" onClick={() => onChange(values.filter((x) => !(x.ats === w.ats && x.slug === w.slug)))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-addrow">
        <select value={ats} aria-label="Board type" onChange={(e) => setAts(e.target.value as typeof ats)}>
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
        </select>
        <input value={slug} aria-label="Board slug" placeholder="slug" onChange={(e) => setSlug(e.target.value)} />
        <input value={name} aria-label="Company name" placeholder="Company name (optional)" onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="cc-ghost"
          disabled={!valid}
          onClick={() => {
            onChange([...values.filter((x) => !(x.ats === ats && x.slug === slug.trim())), { ats, slug: slug.trim(), name: name.trim() }])
            setSlug("")
            setName("")
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function AnswerBank({ answers, onNotice, onChanged }: { answers: CommandCenterState["answers"]; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [edits, setEdits] = useState<Record<string, string>>({})
  async function put(q: string, a: string) {
    try {
      const r = await saveBankAnswer({ data: { question: q, answer: a } })
      onNotice(r.message)
      setEdits((e) => {
        const { [q]: _gone, ...rest } = e
        return rest
      })
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    }
  }
  return (
    <div className="cc-field">
      <span className="cc-hint">Answers reused on every form. Work authorization, sponsorship, demographic and pay questions are only ever filled from here, never guessed.</span>
      {answers.length === 0 && <p className="cc-hint">Nothing saved yet. Answers you give to open form questions land here.</p>}
      <ul className="cc-list cc-answers">
        {answers.map((a) => {
          const value = edits[a.question] ?? a.answer
          return (
            <li key={a.question}>
              <label>
                <span className="cc-label">{a.question}</span>
                <input value={value} onChange={(e) => setEdits((x) => ({ ...x, [a.question]: e.target.value }))} />
              </label>
              <span className="cc-proposal-actions">
                {value !== a.answer && value.trim() && <button type="button" className="cc-small" onClick={() => void put(a.question, value)}>Save</button>}
                <button type="button" className="cc-ghost cc-small" onClick={() => void put(a.question, "")}>Delete</button>
              </span>
            </li>
          )
        })}
      </ul>
      <div className="cc-addrow">
        <input value={question} aria-label="Question" placeholder="Question, as forms word it" onChange={(e) => setQuestion(e.target.value)} />
        <input value={answer} aria-label="Answer" placeholder="Your answer" onChange={(e) => setAnswer(e.target.value)} />
        <button
          type="button"
          className="cc-ghost"
          disabled={question.trim().length < 2 || !answer.trim()}
          onClick={async () => {
            await put(question.trim(), answer.trim())
            setQuestion("")
            setAnswer("")
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function PhoneAccess({ remote, onNotice, onChanged }: { remote: CommandCenterState["remote"]; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [passcode, setPasscode] = useState("")
  async function apply(value: string | null) {
    try {
      await setPhonePasscode({ data: { passcode: value } })
      setPasscode("")
      onNotice(value ? "Phone access is on. Every device has to enter the new passcode." : "Phone access is off. Every device was signed out.")
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    }
  }
  return (
    <div className="cc-field">
      <span className="cc-hint">
        Lets your own phone open this page while the computer is on. The phone must be able to reach the computer (a private tunnel such as Tailscale is the safe way; see the README). Each device enters this passcode once.
      </span>
      <div className="cc-addrow">
        <input type="password" autoComplete="new-password" value={passcode} aria-label="Passcode" placeholder={remote.enabled ? "New passcode (8+ characters)" : "Passcode (8+ characters)"} onChange={(e) => setPasscode(e.target.value)} />
        <button type="button" disabled={passcode.length < 8} onClick={() => void apply(passcode)}>{remote.enabled ? "Change passcode" : "Turn on"}</button>
        {remote.enabled && <button type="button" className="cc-ghost" onClick={() => void apply(null)}>Turn off</button>}
      </div>
    </div>
  )
}

export function ModelSettings({ config, onNotice, onChanged }: { config: CommandCenterState["config"]; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [provider, setProvider] = useState<Provider>(config.provider)
  const [model, setModel] = useState(config.model)
  const [apiKey, setApiKey] = useState("")
  const [baseURL, setBaseURL] = useState(config.baseURL ?? "")

  async function save(e: React.FormEvent) {
    e.preventDefault()
    try {
      await saveAgentSettings({ data: { provider, model, apiKey: apiKey || null, baseURL: provider === "openai-compatible" ? baseURL || null : null } })
      setApiKey("")
      onNotice("Model settings saved.")
      await onChanged()
    } catch (x) {
      onNotice((x as Error).message)
    }
  }

  return (
    <form className="cc-model" onSubmit={save}>
      <span className="cc-label">Model</span>
      <span className="cc-hint">Use your own model account. The key is stored on this computer only and never shown again.</span>
      <div className="cc-row">
        <label className="cc-field">
          <span className="cc-label">Provider</span>
          <select value={provider} onChange={(e) => { const p = e.target.value as Provider; setProvider(p); setModel(p === "anthropic" ? "claude-opus-5-5" : "") }}>
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="cc-field">
          <span className="cc-label">Model name</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "anthropic" ? "claude-opus-5-5" : "model name"} />
        </label>
      </div>
      {provider === "openai-compatible" && (
        <label className="cc-field">
          <span className="cc-label">Base URL</span>
          <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://openrouter.ai/api/v1 or http://localhost:11434/v1" />
        </label>
      )}
      <label className="cc-field">
        <span className="cc-label">API key {config.hasKey && <span className="cc-hint cc-inline">(saved {config.keyHint}, leave blank to keep)</span>}</span>
        <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === "anthropic" ? "sk-ant-..." : "key"} />
      </label>
      <div className="cc-compose-row"><button type="submit" className="cc-ghost">Save model</button></div>
    </form>
  )
}

/** Grades the connected model on five small tasks, so the person knows what to trust it with. */
function ModelCheck({ state, onNotice, onChanged }: { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const { check, briefing } = state.brain
  async function run() {
    setBusy(true)
    try {
      const out = await runModelCheck()
      onNotice(`Model check: ${out.passed} of ${out.total}. ${out.verdict}`)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cc-check">
      <span className="cc-label">Is this model up to the job?</span>
      <span className="cc-hint">Runs five short tasks on the connected model and grades them in code: following a format, sticking to the facts, proposing changes, respecting limits, and coaching. It uses made-up sample data, never yours. It costs a few cents of model usage.</span>
      {check && (
        <>
          <div className="cc-check-head"><strong className="cc-check-score">{check.passed}/{check.total}</strong><span>{check.verdict}<span className="cc-hint"> Checked {new Date(check.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} on {check.model}.</span></span></div>
          <ul className="cc-check-list">
            {check.results.map((r) => (
              <li key={r.key} data-pass={r.pass ? "" : undefined}>
                <span className="cc-check-mark" aria-hidden="true">{r.pass ? "✓" : "✕"}</span>
                <span><strong>{r.label}</strong> <span className="cc-hint">{r.usedFor}</span><span className="cc-check-detail">{r.pass ? "Passed. " : "Failed. "}{r.detail}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="cc-compose-row">
        <button type="button" className="cc-ghost" disabled={busy || !state.config.hasKey && state.config.provider !== "openai-compatible"} onClick={() => void run()}>{busy ? "Checking, about a minute…" : check ? "Run the check again" : "Check this model"}</button>
      </div>
      {briefing && (
        <details className="cc-tokens">
          <summary>What every model is told before it does anything</summary>
          <p className="cc-hint">Built from your resume, your settings, wording you chose yourself, and your standing instructions. It goes in front of every request, so a model that has never seen you starts informed. Your email and phone are not in it.</p>
          <pre className="cc-briefing">{briefing}</pre>
        </details>
      )}
    </div>
  )
}

interface InstallEvent extends Event { prompt: () => Promise<void> }

/** Install the page as an app. Browsers that support it offer a button; iPhone uses the share menu. */
function InstallApp({ onNotice }: { onNotice: (m: string) => void }) {
  const [offer, setOffer] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches)
    const onOffer = (e: Event) => { e.preventDefault(); setOffer(e as InstallEvent) }
    const onDone = () => { setInstalled(true); setOffer(null) }
    window.addEventListener("beforeinstallprompt", onOffer)
    window.addEventListener("appinstalled", onDone)
    return () => { window.removeEventListener("beforeinstallprompt", onOffer); window.removeEventListener("appinstalled", onDone) }
  }, [])
  return (
    <div className="cc-check">
      {installed ? <p className="cc-hint"><strong>You are using the installed app.</strong></p> : (
        <>
          <p className="cc-hint">This puts Armour Pursuit on the home screen or desktop with its own icon and window. It is the same app, and it still talks to the computer that runs your job search, so that computer has to be on.</p>
          {offer && <div className="cc-compose-row"><button type="button" onClick={() => void offer.prompt().catch(() => onNotice("The browser did not open the install prompt. Use its menu instead."))}>Install on this device</button></div>}
          <ul className="cc-bullets cc-tight">
            <li><strong>iPhone or iPad:</strong> open this page in Safari, tap Share, then Add to Home Screen.</li>
            <li><strong>Android:</strong> open in Chrome, tap the menu, then Install app.</li>
            <li><strong>Windows or Mac:</strong> open in Chrome or Edge and use the install icon at the right end of the address bar.</li>
          </ul>
          <p className="cc-hint">On a phone, set up Phone access below first. Installing needs a secure address (https), which the Tailscale setup gives you.</p>
        </>
      )}
    </div>
  )
}
