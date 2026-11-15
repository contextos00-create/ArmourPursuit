import { useEffect, useRef, useState } from "react"
import { gamePlanAction  } from "./jobhunt.functions"
import type {getGamePlan} from "./jobhunt.functions";

export type Plan = Awaited<ReturnType<typeof getGamePlan>>
type PlanDate = Plan["dates"][number]
type Concern = Plan["profile"]["concerns"][number]
type Level = Concern["level"]

/** What the page may change. Everything else on the plan is worked out by the server. */
export interface PlanEdit {
  dates: PlanDate[]
  done: string[]
  confidence: Record<string, number>
  processNotes: string
  profile: Plan["profile"]
}

export const editOf = (p: Plan): PlanEdit => ({ dates: p.dates, done: p.done, confidence: p.confidence, processNotes: p.processNotes, profile: p.profile })

const money = (n: number) => `$${Math.round(n / 1000)}k`
const mins = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} hr${n % 60 ? ` ${n % 60} min` : ""}` : `${n} min`)
const REMIND: { m: number; label: string }[] = [{ m: 10080, label: "1 week" }, { m: 2880, label: "2 days" }, { m: 1440, label: "1 day" }, { m: 120, label: "2 hours" }, { m: 60, label: "1 hour" }, { m: 15, label: "15 min" }]
const KIND_LABEL: Record<PlanDate["kind"], string> = { screen: "Phone screen", interview: "Interview", assessment: "Assessment", other: "Other" }

/** datetime-local value in the browser's own time zone. */
const toLocal = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function Src({ plan, source }: { plan: Plan; source: keyof Plan["sourceLabels"] }) {
  const estimate = source === "typical" || source === "your-postings" || source === "model"
  return <span className={`cc-src${estimate ? " cc-src-est" : ""}`}>{estimate ? "Estimate. " : ""}{plan.sourceLabels[source]}</span>
}

// ── Role brief ─────────────────────────────────────────────────────────────

function Brief({ plan }: { plan: Plan }) {
  const { brief } = plan
  return (
    <section className="cc-brief" aria-label="Role brief">
      <div className="cc-card cc-brief-card cc-brief-process">
        <h3>Likely interview process</h3>
        <ol className="cc-stages">
          {brief.process.map((s) => (
            <li key={s.key} className={`cc-stage cc-stage-${s.state}`}>
              <span className="cc-stage-dot" aria-hidden="true" />
              <div>
                <strong>{s.title}{s.state === "now" && <span className="cc-pill cc-pill-on">You are here</span>}{s.state === "done" && <span className="cc-pill">Done</span>}</strong>
                <span className="cc-hint">{s.detail}</span>
                <Src plan={plan} source={s.source} />
              </div>
            </li>
          ))}
        </ol>
        <p className="cc-hint">{brief.processNote}</p>
      </div>

      <div className="cc-card cc-brief-card">
        <h3>How demanding it looks</h3>
        <div className="cc-level" role="img" aria-label={`${brief.difficulty.label}, level ${brief.difficulty.level} of 4`}>
          {[1, 2, 3, 4].map((n) => <span key={n} className={n <= brief.difficulty.level ? "on" : ""} />)}
          <strong>{brief.difficulty.label}</strong>
        </div>
        <ul className="cc-bullets cc-tight">{brief.difficulty.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        {brief.difficulty.reasons.length === 0 && <p className="cc-hint">Nothing in the posting raises the bar beyond a standard interview.</p>}
        <span className="cc-src cc-src-est">Estimate. {brief.difficulty.source}</span>
      </div>

      <div className="cc-card cc-brief-card">
        <h3>Pay</h3>
        {brief.pay.min != null ? (
          <>
            <div className="cc-big">{money(brief.pay.min)} to {money(brief.pay.max)}</div>
            <Src plan={plan} source={brief.pay.source} />
          </>
        ) : <div className="cc-big cc-big-none">Not known</div>}
        <p className="cc-hint">{brief.pay.basis}</p>
        <h3 className="cc-brief-sub">How fast replies come</h3>
        {brief.responseDays
          ? <p className="cc-hint"><strong>{brief.responseDays.days < 1 ? "Under a day" : `${brief.responseDays.days} day${brief.responseDays.days === 1 ? "" : "s"}`}</strong> is the middle wait for a first reply, across {brief.responseDays.n} of your own applications. <Src plan={plan} source="your-results" /></p>
          : <p className="cc-hint">Not enough of your applications have had a reply yet to say.</p>}
      </div>
    </section>
  )
}

// ── Key dates ──────────────────────────────────────────────────────────────

function Dates({ plan, edit, busy, onSave }: { plan: Plan; edit: PlanEdit; busy: boolean; onSave: (next: PlanEdit) => void }) {
  const [rows, setRows] = useState<PlanDate[]>(edit.dates)
  const key = JSON.stringify(edit.dates)
  useEffect(() => setRows(edit.dates), [key])
  const dirty = JSON.stringify(rows) !== key
  const set = (id: string, patch: Partial<PlanDate>) => setRows((r) => r.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  const add = (kind: PlanDate["kind"]) => {
    const at = new Date()
    at.setDate(at.getDate() + 3)
    at.setHours(10, 0, 0, 0)
    setRows((r) => [...r, { id: `n${Date.now().toString(36)}`, kind, label: "", at: at.getTime(), minutes: kind === "interview" ? 60 : 30, remind: [1440, 60], source: "you" }])
  }
  return (
    <section className="cc-card cc-prep-card">
      <h3>Key dates <span className="cc-hint cc-inline">{plan.reminders.note}</span></h3>
      {rows.length === 0 && <p className="cc-hint">No dates yet. Add your phone screen or interview when you have it. The countdown, the day-by-day plan and the reminders all start from it.</p>}
      {rows.map((d) => d.source === "email" ? (
        <div key={d.id} className="cc-date cc-date-fixed">
          <strong>{d.label}</strong>
          <span>{new Date(d.at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, {d.minutes} min</span>
          <span className="cc-src">{plan.sourceLabels.email}. You get a text one hour before.</span>
        </div>
      ) : (
        <div key={d.id} className="cc-date">
          <select aria-label="Kind of date" value={d.kind} onChange={(e) => set(d.id, { kind: e.target.value as PlanDate["kind"] })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="datetime-local" aria-label="Date and time" value={toLocal(d.at)} onChange={(e) => e.target.value && set(d.id, { at: new Date(e.target.value).getTime() })} />
          <label className="cc-date-min"><input type="number" min={10} max={480} step={5} aria-label="Length in minutes" value={d.minutes} onChange={(e) => set(d.id, { minutes: Number(e.target.value) || 30 })} /> min</label>
          <input type="text" maxLength={80} aria-label="Who or what (optional)" placeholder="Who or what (optional)" value={d.label} onChange={(e) => set(d.id, { label: e.target.value })} />
          <div className="cc-date-remind" role="group" aria-label="Remind me before">
            <span className="cc-hint">Remind me</span>
            {REMIND.map((r) => (
              <button key={r.m} type="button" className="cc-chip" aria-pressed={d.remind.includes(r.m)} onClick={() => set(d.id, { remind: d.remind.includes(r.m) ? d.remind.filter((x) => x !== r.m) : [...d.remind, r.m] })}>{r.label}</button>
            ))}
            <button type="button" className="cc-ghost cc-date-x" onClick={() => setRows((r) => r.filter((x) => x.id !== d.id))}>Remove</button>
          </div>
        </div>
      ))}
      <div className="cc-proposal-actions">
        <button type="button" className="cc-ghost" onClick={() => add("screen")}>Add phone screen</button>
        <button type="button" className="cc-ghost" onClick={() => add("interview")}>Add interview</button>
        <button type="button" className="cc-ghost" onClick={() => add("assessment")}>Add assessment</button>
        {dirty && <button type="button" disabled={busy} onClick={() => onSave({ ...edit, dates: rows })}>{busy ? "Saving…" : "Save dates"}</button>}
      </div>
    </section>
  )
}

// ── Plan of attack ─────────────────────────────────────────────────────────

export function AttackView({ plan, edit, busy, onSave }: { plan: Plan; edit: PlanEdit; busy: boolean; onSave: (next: PlanEdit) => void }) {
  const [notes, setNotes] = useState(edit.processNotes)
  useEffect(() => setNotes(edit.processNotes), [edit.processNotes])
  const toggle = (id: string) => onSave({ ...edit, done: edit.done.includes(id) ? edit.done.filter((x) => x !== id) : [...edit.done, id] })
  return (
    <>
      <Brief plan={plan} />
      <Dates plan={plan} edit={edit} busy={busy} onSave={onSave} />
      {plan.attack.phases.filter((p) => p.tasks.length).map((p) => {
        const left = p.tasks.filter((t) => !t.done)
        return (
          <section key={p.key} className={`cc-card cc-prep-card cc-phase${left.length ? "" : " cc-phase-done"}`}>
            <h3>{p.title} <span className="cc-hint cc-inline">{p.when}. {left.length ? `${left.length} to do, about ${mins(left.reduce((n, t) => n + t.minutes, 0))}` : "All done"}</span></h3>
            {p.note && <p className="cc-hint">{p.note}</p>}
            <ul className="cc-tasks">
              {p.tasks.map((t) => (
                <li key={t.id}>
                  <label>
                    <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
                    <span className="cc-task-body"><span className={t.done ? "cc-task-done" : ""}>{t.title}</span><span className="cc-hint">{t.why}</span></span>
                    <span className="cc-task-min">{mins(t.minutes)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <section className="cc-card cc-prep-card">
        <h3>What you have learned about their process</h3>
        <p className="cc-hint">Anything you read or heard yourself: Glassdoor interview reports, what the recruiter told you, a friend who works there. The app does not read Glassdoor. The coach uses these notes.</p>
        <textarea rows={4} maxLength={3000} aria-label="Your notes on their process" placeholder="Example: recruiter said two rounds, the second is a 90 minute panel with a test plan exercise" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== edit.processNotes && onSave({ ...edit, processNotes: notes })} />
      </section>
    </>
  )
}

// ── Skill builder ──────────────────────────────────────────────────────────

const CONF = ["", "Lost", "Shaky", "Getting there", "Solid", "Ready"]

export function SkillsView({ plan, edit, onSave, onNotice }: { plan: Plan; edit: PlanEdit; onSave: (next: PlanEdit) => void; onNotice: (m: string) => void }) {
  const toggle = (id: string) => onSave({ ...edit, done: edit.done.includes(id) ? edit.done.filter((x) => x !== id) : [...edit.done, id] })
  if (!plan.gaps.length) {
    return <section className="cc-card cc-prep-card"><h3>No gaps to close</h3><p className="cc-hint">Every skill this posting names shows up on your resume. Spend the time on Practice instead.</p></section>
  }
  const steps = plan.gaps.flatMap((g) => g.steps)
  const left = steps.filter((s) => !s.done).reduce((n, s) => n + s.minutes, 0)
  const must = plan.gaps.filter((g) => g.kind === "must").length
  return (
    <>
      <section className="cc-card cc-prep-card cc-skill-sum">
        <h3>{plan.gaps.length} skill{plan.gaps.length === 1 ? "" : "s"} this posting names that your resume does not show</h3>
        <p className="cc-hint">{must} must-have, {plan.gaps.length - must} nice-to-have. {steps.filter((s) => s.done).length} of {steps.length} study steps done, about {mins(left)} left. Nobody matches every line of a posting. The goal is a calm, honest answer for each one, backed by real study. None of this is added to your resume.</p>
      </section>
      {plan.gaps.map((g) => {
        const slug = g.steps[0]?.id.split(":")[1] ?? g.term
        const conf = edit.confidence[`gap:${slug}`] ?? 0
        return (
          <section key={g.term} className={`cc-card cc-prep-card cc-skill cc-skill-${g.kind}`}>
            <h3>{g.name} <span className={`cc-pill${g.kind === "must" ? " cc-pill-warn" : ""}`}>{g.kind === "must" ? "Must-have" : "Nice-to-have"}</span></h3>
            <blockquote className="cc-ask">{g.asks}<cite>{plan.sourceLabels.posting}</cite></blockquote>
            {g.bridge && <p className="cc-bridge">{g.bridge} Lead with that when it comes up.</p>}
            <ul className="cc-tasks">
              {g.steps.map((s) => (
                <li key={s.id}><label><input type="checkbox" checked={s.done} onChange={() => toggle(s.id)} /><span className="cc-task-body"><span className={s.done ? "cc-task-done" : ""}>{s.title}</span></span><span className="cc-task-min">{mins(s.minutes)}</span></label></li>
              ))}
            </ul>
            {g.url
              ? <a className="cc-doc-link" href={g.url} target="_blank" rel="noreferrer">Official documentation to start from</a>
              : <span className="cc-hint">No study guide is built in for this one, so the steps are general. Start from the tool's own documentation.</span>}
            <div className="cc-conf" role="group" aria-label={`How ready you feel about ${g.name}`}>
              <span className="cc-hint">How ready do you feel?</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" className="cc-chip" aria-pressed={conf === n} onClick={() => onSave({ ...edit, confidence: { ...edit.confidence, [`gap:${slug}`]: n } })}>{CONF[n]}</button>
              ))}
            </div>
            <div className="cc-answer">
              <strong>If they ask about it</strong>
              <p>{g.answer}</p>
              <button type="button" className="cc-ghost" onClick={() => (navigator.clipboard as Clipboard | undefined)?.writeText(g.answer).then(() => onNotice("Answer copied."), () => onNotice("Could not copy. Select the text instead."))}>Copy</button>
              <span className="cc-hint">It only mentions study steps you have ticked. Say it in your own words.</span>
            </div>
          </section>
        )
      })}
    </>
  )
}

// ── Coach ──────────────────────────────────────────────────────────────────

const LEVELS: { v: Level | "off"; label: string }[] = [{ v: "off", label: "Fine" }, { v: "low", label: "A little" }, { v: "medium", label: "Worried" }, { v: "high", label: "Very worried" }]

export function CoachView({ plan, edit, onSave, onPlan, onNotice }: { plan: Plan; edit: PlanEdit; onSave: (next: PlanEdit) => void; onPlan: (p: Plan) => void; onNotice: (m: string) => void }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }) }, [plan.chat.length])

  const levelOf = (key: string): Level | "off" => edit.profile.concerns.find((c) => c.key === key)?.level ?? "off"
  const setLevel = (key: string, label: string, v: Level | "off") => {
    const rest = edit.profile.concerns.filter((c) => c.key !== key)
    const old = edit.profile.concerns.find((c) => c.key === key)
    onSave({ ...edit, profile: { ...edit.profile, concerns: v === "off" ? rest : [...rest, { topic: old?.topic || label, key: key as Concern["key"], level: v, note: old?.note ?? "" }] } })
  }
  async function send(message: string) {
    if (!message.trim() || sending) return
    setSending(true)
    try {
      const out = await gamePlanAction({ data: { id: plan.id, action: "coach", text: message } })
      setText("")
      onPlan(out.view)
      if (out.message) onNotice(out.message)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const extra = edit.profile.concerns.filter((c) => !c.key)
  const added = plan.attack.phases[0]?.tasks.filter((t) => t.id.startsWith("concern:") || t.id.startsWith("focus:")).length ?? 0

  return (
    <>
      <section className="cc-card cc-prep-card">
        <h3>What is on your mind about this one?</h3>
        <p className="cc-hint">Mark anything that worries you about {plan.company}. Each one you mark as worried adds matching practice to the top of your plan. {added > 0 ? `Right now ${added} task${added === 1 ? "" : "s"} in your plan come from here.` : ""}</p>
        <div className="cc-concerns">
          {plan.concernTopics.map((t) => (
            <div key={t.key} className="cc-concern">
              <span>{t.label}</span>
              <div className="cc-segmented cc-views" role="group" aria-label={t.label}>
                {LEVELS.map((l) => <button key={l.v} type="button" aria-pressed={levelOf(t.key) === l.v} onClick={() => setLevel(t.key, t.label, l.v)}>{l.label}</button>)}
              </div>
            </div>
          ))}
        </div>
        {(extra.length > 0 || edit.profile.focus.length > 0 || edit.profile.style) && (
          <div className="cc-coach-notes">
            <strong>From your talk with the coach</strong>
            {edit.profile.style && <p className="cc-hint">How you want to prep: {edit.profile.style}</p>}
            <ul className="cc-bullets cc-tight">
              {edit.profile.concerns.filter((c) => c.note).map((c) => <li key={`n${c.topic}`}>{c.topic}: {c.note}</li>)}
              {extra.filter((c) => !c.note).map((c) => <li key={c.topic}>{c.topic}</li>)}
              {edit.profile.focus.map((f) => (
                <li key={f}>Practice: {f} <button type="button" className="cc-linkish" onClick={() => onSave({ ...edit, profile: { ...edit.profile, focus: edit.profile.focus.filter((x) => x !== f) } })}>Remove</button></li>
              ))}
            </ul>
            <span className="cc-src cc-src-est">{plan.sourceLabels.model}</span>
          </div>
        )}
      </section>

      <section className="cc-card cc-prep-card cc-coach">
        <h3>Talk it through <span className="cc-hint cc-inline">A model, not a person. It knows this posting, your gaps and your dates.</span></h3>
        {!plan.hasModel ? (
          <p className="cc-hint">No model is connected, so the chat is off. The check above works without one. To turn the chat on, add a model and key under Controls.</p>
        ) : (
          <>
            <p className="cc-hint">Ask about a part of the process, or say what you are nervous about. What you say here changes what the plan has you practice. It will not invent facts about {plan.company}, and it is a coach, not a therapist.</p>
            <div className="cc-coach-log" aria-live="polite">
              {plan.chat.length === 0 && (
                <div className="cc-coach-starts">
                  {["I am nervous about the technical questions", `What should I expect from a first call with ${plan.company}?`, "How do I answer when they ask about a tool I have not used?"].map((s) => (
                    <button key={s} type="button" className="cc-chip" disabled={sending} onClick={() => void send(s)}>{s}</button>
                  ))}
                </div>
              )}
              {plan.chat.map((m, i) => <div key={i} className={`cc-coach-msg cc-coach-${m.role}`}>{m.content}</div>)}
              {sending && <div className="cc-coach-msg cc-coach-assistant cc-coach-wait">Thinking…</div>}
              <div ref={end} />
            </div>
            <form className="cc-coach-form" onSubmit={(e) => { e.preventDefault(); void send(text) }}>
              <textarea rows={2} maxLength={2000} aria-label="Message to the coach" placeholder="What is worrying you, or what do you want to know?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text) } }} />
              <button type="submit" disabled={sending || !text.trim()}>Send</button>
            </form>
            {plan.chat.length > 0 && (
              <button type="button" className="cc-linkish" onClick={async () => { try { onPlan((await gamePlanAction({ data: { id: plan.id, action: "clear" } })).view) } catch (e) { onNotice((e as Error).message) } }}>Clear this conversation</button>
            )}
          </>
        )}
      </section>
    </>
  )
}
