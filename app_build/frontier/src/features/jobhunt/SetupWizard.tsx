import { useRef, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { completeSetup, importResumeJson, runAutomation, saveJobSettings, saveProfile } from "./jobhunt.functions"
import { ModelSettings } from "./ControlsPanel"
import { NotifySettings } from "./NotifyPanel"
import { Lever } from "./ui"

type Settings = CommandCenterState["settings"]
type Profile = CommandCenterState["setup"]["profile"]

const STEPS = ["You and your resume", "What to look for", "Notifications", "Agent model", "Check and finish"] as const
const csv = (text: string) => [...new Set(text.split(",").map((p) => p.trim()).filter(Boolean))]

function Text({ label, hint, value, onChange, type, placeholder, required }: { label: string; hint?: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean }) {
  return (
    <label className="cc-field">
      <span className="cc-label">{label}{required && <span className="cc-hint cc-inline"> (needed)</span>}</span>
      {hint && <span className="cc-hint">{hint}</span>}
      <input type={type ?? "text"} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

/** First-time setup: five short steps, each saved as you go. Can be reopened from Controls. */
export function SetupWizard({ state, onNotice, onChanged, onClose }: { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>(() => (state.setup.profile.work.length ? state.setup.profile : { ...state.setup.profile, work: [{ name: "", position: "", startDate: "", endDate: "", highlights: [] }] }))
  const [s, setS] = useState<Settings>(state.settings)
  const [titles, setTitles] = useState(state.settings.targetTitles.join(", "))
  const [places, setPlaces] = useState(state.settings.locations.join(", "))
  const [skills, setSkills] = useState(state.setup.profile.skills.join(", "))
  const file = useRef<HTMLInputElement>(null)
  const set = <TKey extends keyof Settings>(key: TKey, value: Settings[TKey]) => setS((cur) => ({ ...cur, [key]: value }))
  const setP = <TKey extends keyof Profile>(key: TKey, value: Profile[TKey]) => setProfile((cur) => ({ ...cur, [key]: value }))
  const setJob = (i: number, patch: Partial<Profile["work"][number]>) => setP("work", profile.work.map((w, n) => (n === i ? { ...w, ...patch } : w)))
  const setSchool = (i: number, patch: Partial<Profile["education"][number]>) => setP("education", profile.education.map((w, n) => (n === i ? { ...w, ...patch } : w)))

  async function next() {
    setBusy(true)
    setError(null)
    try {
      if (step === 0) {
        if (!profile.name.trim()) throw new Error("Add your name.")
        if (!profile.work.some((w) => w.name.trim() && w.position.trim())) throw new Error("Add at least one job with an employer and a title.")
      }
      if (step === 0) await saveProfile({ data: { ...profile, skills: csv(skills), work: profile.work.filter((w) => w.name.trim() || w.position.trim()) } })
      if (step === 1) {
        const targetTitles = csv(titles)
        if (!targetTitles.length) throw new Error("Add at least one job title to look for.")
        setS(await saveJobSettings({ data: { ...s, targetTitles, locations: csv(places) } }))
      }
      if (step === 2) setS(await saveJobSettings({ data: { ...s, targetTitles: csv(titles), locations: csv(places) } }))
      await onChanged()
      setStep((n) => Math.min(STEPS.length - 1, n + 1))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function finish(findJobs: boolean) {
    setBusy(true)
    setError(null)
    try {
      await completeSetup()
      if (findJobs) onNotice((await runAutomation({ data: { action: "discover" } })).message)
      else onNotice("Setup finished.")
      await onChanged()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function upload(f: File | undefined) {
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      await importResumeJson({ data: { text: await f.text() } })
      await onChanged()
      onNotice("Resume imported. Reopen setup to review it, or keep going.")
      setStep(1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ""
    }
  }

  return (
    <section className="cc-setup" aria-label="First-time setup">
      <header className="cc-setup-head">
        <div>
          <h2>Setup, step {step + 1} of {STEPS.length}</h2>
          <h3 className="cc-setup-title">{STEPS[step]}</h3>
        </div>
        {state.setup.done && <button type="button" className="cc-ghost" onClick={onClose}>Close</button>}
      </header>
      <ol className="cc-steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "cc-step-on" : i < step ? "cc-step-done" : ""} aria-current={i === step ? "step" : undefined}>
            <button type="button" className="cc-ghost cc-small" disabled={busy || i > step} onClick={() => setStep(i)}><span className="cc-step-n">{i + 1}</span> {label}</button>
          </li>
        ))}
      </ol>

      <div className="cc-card cc-setup-body">
        {step === 0 && (
          <>
            <p className="cc-hint">Everything the app writes for you is built from what you enter here, word for word. It never adds experience you did not list. This stays on your computer.</p>
            <div className="cc-addrow">
              <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void upload(e.target.files?.[0])} />
              <button type="button" className="cc-ghost" disabled={busy} onClick={() => file.current?.click()}>Upload a JSON Resume file instead</button>
            </div>
            <div className="cc-row">
              <Text label="Full name" required value={profile.name} onChange={(v) => setP("name", v)} />
              <Text label="Headline" hint="For example: QA Engineer" value={profile.label} onChange={(v) => setP("label", v)} />
            </div>
            <div className="cc-row">
              <Text label="Email for applications" type="email" value={profile.email} onChange={(v) => setP("email", v)} />
              <Text label="Phone" type="tel" value={profile.phone} onChange={(v) => setP("phone", v)} />
            </div>
            <div className="cc-row">
              <Text label="City" value={profile.city} onChange={(v) => setP("city", v)} />
              <Text label="State or region" value={profile.region} onChange={(v) => setP("region", v)} />
            </div>
            <label className="cc-field">
              <span className="cc-label">Summary</span>
              <textarea rows={3} maxLength={1500} value={profile.summary} onChange={(e) => setP("summary", e.target.value)} />
            </label>

            <h2>Jobs <span className="cc-hint cc-inline">(at least one)</span></h2>
            {profile.work.map((w, i) => (
              <div key={i} className="cc-setup-item">
                <div className="cc-row">
                  <Text label="Employer" value={w.name} onChange={(v) => setJob(i, { name: v })} />
                  <Text label="Job title" value={w.position} onChange={(v) => setJob(i, { position: v })} />
                </div>
                <div className="cc-row">
                  <Text label="Started" placeholder="2021-03" value={w.startDate} onChange={(v) => setJob(i, { startDate: v })} />
                  <Text label="Ended" placeholder="Blank if current" value={w.endDate} onChange={(v) => setJob(i, { endDate: v })} />
                </div>
                <label className="cc-field">
                  <span className="cc-label">What you did, one accomplishment per line</span>
                  <span className="cc-hint">These exact lines are what gets picked and reordered for each posting.</span>
                  <textarea rows={4} value={w.highlights.join("\n")} onChange={(e) => setJob(i, { highlights: e.target.value.split("\n") })} />
                </label>
                {profile.work.length > 1 && <button type="button" className="cc-ghost cc-small" onClick={() => setP("work", profile.work.filter((_, n) => n !== i))}>Remove this job</button>}
              </div>
            ))}
            <div><button type="button" className="cc-ghost" onClick={() => setP("work", [...profile.work, { name: "", position: "", startDate: "", endDate: "", highlights: [] }])}>Add another job</button></div>

            <label className="cc-field">
              <span className="cc-label">Skills, separated by commas</span>
              <textarea rows={2} value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="Playwright, SQL, Postman" />
            </label>

            <h2>Education <span className="cc-hint cc-inline">(optional)</span></h2>
            {profile.education.map((ed, i) => (
              <div key={i} className="cc-setup-item">
                <div className="cc-row">
                  <Text label="School" value={ed.institution} onChange={(v) => setSchool(i, { institution: v })} />
                  <Text label="Degree or certificate" value={ed.studyType} onChange={(v) => setSchool(i, { studyType: v })} />
                </div>
                <div className="cc-row">
                  <Text label="Field" value={ed.area} onChange={(v) => setSchool(i, { area: v })} />
                  <Text label="Finished" placeholder="2019" value={ed.endDate} onChange={(v) => setSchool(i, { endDate: v })} />
                </div>
                <button type="button" className="cc-ghost cc-small" onClick={() => setP("education", profile.education.filter((_, n) => n !== i))}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="cc-ghost" onClick={() => setP("education", [...profile.education, { institution: "", studyType: "", area: "", endDate: "" }])}>Add education</button></div>
          </>
        )}

        {step === 1 && (
          <>
            <Text label="Job titles to look for, separated by commas" required placeholder="QA Engineer, SDET, Test Automation Engineer" value={titles} onChange={setTitles} />
            <Text label="Places you can work on site, separated by commas" hint="For hybrid and on-site roles. Leave blank if remote only." placeholder="Cincinnati" value={places} onChange={setPlaces} />
            <div className="cc-field">
              <span className="cc-label">Work modes</span>
              <div className="cc-segmented" role="group" aria-label="Work modes">
                {(["remote", "hybrid", "onsite"] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={s.workModes.includes(mode)} onClick={() => set("workModes", s.workModes.includes(mode) ? s.workModes.filter((x) => x !== mode) : [...s.workModes, mode])}>{mode}</button>
                ))}
              </div>
              <span className="cc-hint">None picked means any.</span>
            </div>
            <div className="cc-row">
              <label className="cc-field">
                <span className="cc-label">Lowest pay to consider (USD a year)</span>
                <span className="cc-hint">0 means no floor.</span>
                <input type="number" inputMode="numeric" min={0} step={1000} value={s.salaryFloor} onChange={(e) => set("salaryFloor", Number(e.target.value))} />
              </label>
              <label className="cc-field">
                <span className="cc-label">Your level</span>
                <span className="cc-hint">Leave on the first choice to read it from your resume.</span>
                <select value={s.seniority} onChange={(e) => set("seniority", e.target.value as Settings["seniority"])}>
                  <option value="">From your resume</option>
                  <option value="junior">Junior</option>
                  <option value="mid">Mid</option>
                  <option value="senior">Senior</option>
                  <option value="staff">Staff</option>
                </select>
              </label>
            </div>
            <Lever label="New postings a day" hint="How many new matches to bring you each day." value={s.dailyTarget} min={1} max={50} onChange={(n) => set("dailyTarget", n)} />
            <p className="cc-hint">The rest starts on sensible defaults: tailor at fit 80 and up, ask you first from 65, and you press Submit on every application. Change any of it later under Controls.</p>
          </>
        )}

        {step === 2 && <NotifySettings state={state} s={s} set={set} onNotice={onNotice} />}

        {step === 3 && (
          <>
            <p className="cc-hint">Optional. With your own model account the agent can chat about strategy, research companies and help word your resume. Finding, scoring and filling forms all work without it.</p>
            {state.local ? <ModelSettings config={state.config} onNotice={onNotice} onChanged={onChanged} /> : <p className="cc-hint">The model and its key can only be set on the computer itself.</p>}
          </>
        )}

        {step === 4 && (
          <>
            <ul className="cc-checklist">
              {state.setup.checks.map((c) => (
                <li key={c.key} className={c.ok ? "cc-check-ok" : c.required ? "cc-check-need" : "cc-check-skip"}>
                  <span className="cc-check-mark" aria-hidden="true">{c.ok ? "✓" : c.required ? "!" : "–"}</span>
                  <span><strong>{c.label}</strong> <span className="cc-hint cc-inline">{c.ok ? "Ready" : c.required ? "Needed" : "Not set up"}</span><span className="cc-hint">{c.hint}</span></span>
                </li>
              ))}
            </ul>
            <p className="cc-hint">Items marked "Not set up" are optional and can be added any time. Nothing is sent to an employer unless you press Submit.</p>
          </>
        )}

        {error && <p className="cc-err" role="alert">{error}</p>}
        <div className="cc-setup-nav">
          <button type="button" className="cc-ghost" disabled={busy || step === 0} onClick={() => setStep((n) => n - 1)}>Back</button>
          {step < STEPS.length - 1 ? (
            <button type="button" disabled={busy} onClick={() => void next()}>{busy ? "Saving…" : step === 3 ? "Next" : "Save and continue"}</button>
          ) : (
            <span className="cc-proposal-actions">
              <button type="button" className="cc-ghost" disabled={busy} onClick={() => void finish(false)}>Finish</button>
              <button type="button" disabled={busy || state.paused} onClick={() => void finish(true)}>{busy ? "Working…" : "Finish and find jobs now"}</button>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
