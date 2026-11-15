import { useEffect, useMemo, useRef, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { AttackView, CoachView, SkillsView, editOf   } from "./GamePlan"
import type {Plan, PlanEdit} from "./GamePlan";
import { gamePlanAction, getGamePlan, openPrepPack, saveGamePlan, savePrepNotes } from "./jobhunt.functions"
import { Ring, STATUS_LABEL, openDocument } from "./ui"

type Prep = CommandCenterState["prep"][number]

function Questions({ title, hint, items, practiced, onToggle }: { title: string; hint?: string; items: string[]; practiced: string[]; onToggle: (q: string) => void }) {
  return (
    <section className="cc-card cc-prep-card">
      <h3>{title} <span className="cc-hint cc-inline">{items.filter((q) => practiced.includes(q)).length} of {items.length} practiced</span></h3>
      {hint && <p className="cc-hint">{hint}</p>}
      <ul className="cc-qs">
        {items.map((q) => (
          <li key={q}>
            <label><input type="checkbox" checked={practiced.includes(q)} onChange={() => onToggle(q)} /> <span>{q}</span></label>
          </li>
        ))}
      </ul>
    </section>
  )
}

type View = "plan" | "skills" | "practice" | "coach"
const VIEWS: { id: View; label: string }[] = [{ id: "plan", label: "Plan of attack" }, { id: "skills", label: "Skill builder" }, { id: "practice", label: "Practice" }, { id: "coach", label: "Coach" }]

function countdown(plan: Plan): string {
  const { next, daysOut } = plan.attack
  if (!next || daysOut == null) return "No date set yet"
  const what = next.label || { screen: "Phone screen", interview: "Interview", assessment: "Assessment", other: "Next date" }[next.kind]
  const hours = Math.round((next.at - Date.now()) / 3_600_000)
  return `${what} ${hours <= 0 ? "is now" : hours < 24 ? `in ${hours} hour${hours === 1 ? "" : "s"}` : `in ${daysOut} day${daysOut === 1 ? "" : "s"}`}`
}

/**
 * Prep for one role: a plan of attack built from that posting, a skill builder
 * for its gaps, practice from the person's own resume, and a coach.
 */
export function PrepPanel({ state, onNotice, onChanged }: { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [picked, setPicked] = useState<string | null>(null)
  const current: Prep | undefined = state.prep.find((p) => p.id === picked) ?? state.prep.at(0)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [practiced, setPracticed] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<View>("plan")
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const wanted = useRef<string | null>(null)

  const currentId = current?.id ?? null
  useEffect(() => {
    wanted.current = currentId
    setPlan(null)
    if (!currentId) return
    getGamePlan({ data: { id: currentId } }).then((p) => { if (wanted.current === currentId) setPlan(p) }, (e) => onNotice((e as Error).message))
  }, [currentId, current?.status])

  /** Show the change at once, then take the server's recomputed plan. */
  async function savePlan(next: PlanEdit) {
    if (!plan) return
    const id = plan.id
    setPlan({ ...plan, ...next })
    setPlanBusy(true)
    try {
      const fresh = await saveGamePlan({ data: { id, plan: { ...next, dates: next.dates.filter((d) => d.source !== "email").map(({ source: _s, ...d }) => d) } } })
      if (wanted.current === id) setPlan(fresh)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setPlanBusy(false)
    }
  }

  const savedKey = current ? JSON.stringify([current.id, current.notes, current.practiced]) : ""
  useEffect(() => {
    setNotes(current?.notes ?? {})
    setPracticed(current?.practiced ?? [])
  }, [savedKey])

  const questions = useMemo(() => (current ? [...current.technical, ...current.behavioral, ...(plan?.questions ?? [])] : []), [current, plan?.questions])
  if (!current) {
    return (
      <div className="cc-prep">
        <p className="cc-empty-note">Prep shows up here once an application is sent. Each one gets the resume bullets that prove its requirements, likely questions, and room for your notes.</p>
      </div>
    )
  }

  const dirty = JSON.stringify([notes, practiced]) !== JSON.stringify([current.notes, current.practiced])
  const done = questions.filter((q) => practiced.includes(q)).length
  const toggle = (q: string) => setPracticed((p) => (p.includes(q) ? p.filter((x) => x !== q) : [...p, q]))
  const note = (key: string, value: string) => setNotes((n) => ({ ...n, [key]: value }))

  async function save() {
    if (!current) return
    setSaving(true)
    try {
      onNotice((await savePrepNotes({ data: { id: current.id, notes, practiced } })).message)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const live = state.prep.filter((p) => p.live)
  const early = state.prep.filter((p) => !p.live)

  return (
    <div className="cc-prep">
      <nav className="cc-prep-pick" aria-label="Pick an application">
        {[{ label: "Interview stage", rows: live }, { label: "Sent, get ahead", rows: early }].filter((g) => g.rows.length).map((g) => (
          <div key={g.label} className="cc-prep-group">
            <h2>{g.label}</h2>
            {g.rows.map((p) => (
              <button key={p.id} type="button" className="cc-prep-item" aria-pressed={p.id === current.id} onClick={() => setPicked(p.id)}>
                <strong>{p.company}</strong>
                <span>{p.title}</span>
                <span className={`cc-status cc-status-${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="cc-prep-body">
        <header className="cc-card cc-prep-head">
          <Ring share={plan && plan.attack.total ? plan.attack.doneCount / plan.attack.total : 0} size={56} label={plan ? `${plan.attack.doneCount} of ${plan.attack.total} plan tasks done` : "Loading the plan"} />
          <div className="cc-grow">
            <h3 className="cc-prep-title">{current.company}</h3>
            <span className="cc-hint">{current.title}</span>
            {plan && <span className="cc-prep-count"><strong>{countdown(plan)}</strong>{plan.attack.total > 0 && <> · {plan.attack.doneCount} of {plan.attack.total} tasks done · about {plan.attack.minutes >= 60 ? `${Math.round(plan.attack.minutes / 6) / 10} hours` : `${plan.attack.minutes} min`} of prep left</>}</span>}
          </div>
          <span className="cc-proposal-actions">
            <button
              type="button"
              className="cc-ghost"
              onClick={async () => {
                try {
                  openDocument(await openPrepPack({ data: { id: current.id } }))
                } catch (e) {
                  onNotice((e as Error).message)
                }
              }}
            >
              Printable pack
            </button>
          </span>
        </header>

        <div className="cc-segmented cc-views cc-prep-views" role="group" aria-label="Prep sections">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}>
              {v.label}{v.id === "skills" && plan && plan.gaps.length > 0 && <span className="cc-count">{plan.gaps.length}</span>}
            </button>
          ))}
        </div>

        {view !== "practice" && !plan && <p className="cc-hint">Building the plan for this role…</p>}
        {view === "plan" && plan && <AttackView plan={plan} edit={editOf(plan)} busy={planBusy} onSave={(n) => void savePlan(n)} />}
        {view === "skills" && plan && <SkillsView plan={plan} edit={editOf(plan)} onSave={(n) => void savePlan(n)} onNotice={onNotice} />}
        {view === "coach" && plan && <CoachView plan={plan} edit={editOf(plan)} onSave={(n) => void savePlan(n)} onPlan={setPlan} onNotice={onNotice} />}

        {view === "practice" && (<>
        <section className="cc-card cc-prep-card cc-prep-head">
          <span className="cc-hint cc-grow">{done} of {questions.length} questions practiced, {current.covered.length} requirements backed by your resume{current.uncovered.length ? `, ${current.uncovered.length} not shown on it (see Skill builder)` : ""}.</span>
          <button type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : dirty ? "Save notes" : "Saved"}</button>
        </section>

        <section className="cc-card cc-prep-card">
          <h3>Your proof for each requirement</h3>
          <p className="cc-hint">These are lines from your own resume. Tell each as a story: the situation, what you did, the result. Only details that really happened.</p>
          {current.covered.length === 0 && <p className="cc-hint">The posting's must-haves did not match a resume bullet. Use the list below to plan honest answers.</p>}
          {current.covered.map((c, i) => (
            <div key={c.requirement} className="cc-proof">
              <strong>{c.requirement}</strong>
              {c.proof.map((p) => <blockquote key={p.text}>{p.text}<cite>{p.where}</cite></blockquote>)}
              <textarea rows={2} maxLength={2000} aria-label={`Your story notes for: ${c.requirement}`} placeholder="Situation, what you did, result" value={notes[`c${i}`] ?? ""} onChange={(e) => note(`c${i}`, e.target.value)} />
            </div>
          ))}
        </section>

        <Questions title="Likely technical questions" items={current.technical} practiced={practiced} onToggle={toggle} />
        <Questions title="Behavioral questions" items={current.behavioral} practiced={practiced} onToggle={toggle} />

        {plan && (plan.questions.length > 0
          ? <Questions title={`Written for this posting at ${current.company}`} hint={`${plan.sourceLabels.model}. They are guesses at what could be asked, not questions this company is known to ask.`} items={plan.questions} practiced={practiced} onToggle={toggle} />
          : (
            <section className="cc-card cc-prep-card">
              <h3>Questions written for this posting</h3>
              <p className="cc-hint">{plan.hasModel ? "Have the model read this posting and write practice questions from it. They are guesses, labeled as such." : "Connect a model under Controls to get practice questions written from this exact posting. The questions above work without one."}</p>
              {plan.hasModel && (
                <button
                  type="button"
                  className="cc-ghost"
                  disabled={asking}
                  onClick={async () => {
                    setAsking(true)
                    try {
                      const out = await gamePlanAction({ data: { id: plan.id, action: "questions" } })
                      setPlan(out.view)
                      onNotice(out.message)
                    } catch (e) {
                      onNotice((e as Error).message)
                    } finally {
                      setAsking(false)
                    }
                  }}
                >
                  {asking ? "Writing…" : "Write questions for this role"}
                </button>
              )}
            </section>
          ))}

        <section className="cc-card cc-prep-card">
          <h3>Questions to ask them</h3>
          <ul className="cc-bullets">{current.askThem.map((q) => <li key={q}>{q}</li>)}</ul>
        </section>

        <section className="cc-card cc-prep-card">
          <h3>Your notes</h3>
          <textarea rows={4} maxLength={2000} aria-label="Your notes for this interview" placeholder="Who you are meeting, when, what to bring up" value={"general" in notes ? notes.general : ""} onChange={(e) => note("general", e.target.value)} />
        </section>
        </>)}
      </div>
    </div>
  )
}
