import { useCallback, useEffect, useRef, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { getResumeWorkshop, resumeWorkshopAction, saveResumeChoices } from "./jobhunt.functions"
import { Ring, STATUS_LABEL, Switch } from "./ui"

type View = Awaited<ReturnType<typeof getResumeWorkshop>>
type Line = View["roles"][number]["lines"][number]
type Choices = Parameters<typeof saveResumeChoices>[0]["data"]["choices"]
type Props = { state: CommandCenterState; visible: boolean; onNotice: (m: string) => void; onChanged: () => Promise<void> }

const day = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const OPEN = ["saved", "tailored", "applied", "acknowledged", "assessment", "screening", "interviewing"]

function toChoices(v: View): Choices {
  const c = v.choices
  return { headline: c.headline, summaryMode: c.summaryMode, summaryText: c.summaryText, bullets: c.bullets, pinned: c.pinned, rolesOff: c.rolesOff, skillsOff: c.skillsOff, notes: c.notes }
}

function LineRow({ line, hasModel, busy, onToggle, onText, onPin, onSuggest, onDropSuggestion }: {
  line: Line; hasModel: boolean; busy: boolean
  onToggle: (on: boolean) => void; onText: (text: string | null) => void; onPin: () => void; onSuggest: () => void; onDropSuggestion: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(line.text)
  useEffect(() => setText(line.text), [line.text])
  return (
    <li className="cc-line" data-on={line.on || undefined}>
      <label className="cc-line-main">
        <input type="checkbox" checked={line.on} disabled={busy} onChange={(e) => onToggle(e.target.checked)} aria-label={`Include: ${line.text}`} />
        <span>
          {line.text}
          {line.hits.length > 0 && <span className="cc-line-hits">{line.hits.map((h) => <i key={h}>{h}</i>)}</span>}
        </span>
      </label>
      <span className="cc-line-tools">
        {line.pinned && <span className="cc-badge">Pinned first</span>}
        {line.edited && <span className="cc-badge">Your wording</span>}
        <button type="button" className="cc-ghost cc-small" disabled={busy} onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Reword"}</button>
        <button type="button" className="cc-ghost cc-small" disabled={busy} aria-pressed={line.pinned} onClick={onPin}>{line.pinned ? "Unpin" : "Pin first"}</button>
        {hasModel && <button type="button" className="cc-ghost cc-small" disabled={busy} onClick={onSuggest}>Ask agent</button>}
      </span>
      {line.flag && <p className="cc-draft-block">Check this: {line.flag}. Keep it only if it is true. You can also add it to your saved resume in Setup.</p>}
      {editing && (
        <div className="cc-line-edit">
          <textarea rows={3} maxLength={600} value={text} aria-label="Your wording for this line" onChange={(e) => setText(e.target.value)} />
          <span className="cc-proposal-actions">
            <button type="button" disabled={busy || !text.trim() || text === line.text} onClick={() => { onText(text.trim()); setEditing(false) }}>Use my wording</button>
            {line.edited && <button type="button" className="cc-ghost" disabled={busy} onClick={() => { onText(null); setEditing(false) }}>Back to original</button>}
          </span>
          {line.edited && <span className="cc-hint">Original: {line.master}</span>}
        </div>
      )}
      {line.suggestion && (
        <div className="cc-suggest">
          <span className="cc-label">Agent suggestion (same facts, checked against your resume)</span>
          <p>{line.suggestion}</p>
          <span className="cc-proposal-actions">
            <button type="button" className="cc-small" disabled={busy} onClick={() => onText(line.suggestion)}>Use this</button>
            <button type="button" className="cc-ghost cc-small" disabled={busy} onClick={onDropSuggestion}>No thanks</button>
          </span>
        </div>
      )}
    </li>
  )
}

/** Resume workshop: build one posting's resume line by line, with agent research and wording suggestions. */
export function ResumePanel({ state, visible, onNotice, onChanged }: Props) {
  const apps = state.applications.filter((a) => OPEN.includes(a.status))
  const [picked, setPicked] = useState<string | null>(null)
  const id = picked ?? apps.at(0)?.id ?? null
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [urls, setUrls] = useState("")
  const [notes, setNotes] = useState("")
  const [headline, setHeadline] = useState("")
  const [custom, setCustom] = useState("")
  const [wide, setWide] = useState(false)
  const seq = useRef(0)

  const adopt = useCallback((v: View) => {
    setView(v)
    setNotes(v.notes)
    setHeadline(v.headline.value)
    setCustom(v.summary.custom || v.summary.targeted || v.summary.master)
  }, [])

  useEffect(() => {
    if (!visible || !id) return
    const mine = ++seq.current
    setView((v) => (v?.id === id ? v : null))
    getResumeWorkshop({ data: { id } }).then((v) => { if (seq.current === mine) adopt(v) }).catch((e) => onNotice((e as Error).message))
  }, [visible, id, adopt, onNotice])

  if (!id) return <p className="cc-empty-note">The workshop opens once a posting is on your list. Each one gets its own resume, built from your real lines and tuned to that posting.</p>

  async function change(patch: Partial<Choices>) {
    if (!view) return
    setBusy("save")
    try {
      adopt(await saveResumeChoices({ data: { id: view.id, choices: { ...toChoices(view), ...patch } } }))
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function run(action: "suggest" | "research" | "agent" | "save" | "reset", lines?: string[]) {
    if (!view) return
    setBusy(action)
    try {
      // Notes and choices are saved first so the agent works from what is on screen.
      if (notes !== view.notes) await saveResumeChoices({ data: { id: view.id, choices: { ...toChoices(view), notes } } })
      const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean).slice(0, 4)
      const r = await resumeWorkshopAction({ data: { id: view.id, action, lines, urls: list } })
      adopt(r.view)
      onNotice(r.message)
      if (action === "save" || action === "reset") await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const bullet = (line: Line, patch: { on?: boolean; text?: string | null }, drop = false) => {
    if (!view) return
    const cur = { ...(view.choices.bullets[line.id] ?? {}) }
    if (patch.on !== undefined) cur.on = patch.on
    if (patch.text !== undefined) {
      if (patch.text && patch.text !== line.master) cur.text = patch.text
      else delete cur.text
    }
    void change({ bullets: { ...view.choices.bullets, [line.id]: cur }, ...(drop || patch.text !== undefined ? { dropSuggestions: [line.id] } : {}) })
  }
  const toggleIn = (list: string[], key: string) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key])
  const working = busy !== null

  return (
    <div className="cc-prep cc-resume">
      <nav className="cc-prep-pick" aria-label="Pick a posting">
        <div className="cc-prep-group">
          {apps.slice(0, 30).map((a) => (
            <button key={a.id} type="button" className="cc-prep-item" aria-pressed={a.id === id} onClick={() => setPicked(a.id)}>
              <strong>{a.company}</strong>
              <span>{a.title}</span>
              <span className={`cc-status cc-status-${a.status}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
            </button>
          ))}
        </div>
      </nav>

      {!view ? <p className="cc-empty-note">Loading the workshop…</p> : (
        <div className="cc-resume-body" data-wide={wide || undefined}>
          <div className="cc-resume-edit">
            <header className="cc-card cc-prep-head">
              <Ring share={view.coverage.onResume ? view.coverage.inDraft / view.coverage.onResume : 0} size={56} label={`${view.coverage.inDraft} of ${view.coverage.onResume} keywords`} />
              <div className="cc-grow">
                <h3 className="cc-prep-title">{view.company}</h3>
                <span className="cc-hint">{view.title}. This version shows {view.coverage.inDraft} of the {view.coverage.onResume} posting keywords your resume can back. {view.lineCount} lines, about {view.words} words.</span>
                <span className="cc-hint">{view.savedAt ? `Your version was saved ${day(view.savedAt)}. It is the resume used for this posting, and automatic tailoring will not replace it.` : "Not saved yet. Until you save, this posting uses the automatic version."}</span>
              </div>
              <span className="cc-proposal-actions">
                <button type="button" disabled={working} onClick={() => void run("agent")}>{busy === "agent" ? "Agent working…" : "Run agent pass"}</button>
                <button type="button" disabled={working} onClick={() => void run("save")}>{busy === "save" ? "Saving…" : "Save as this job's resume"}</button>
                {view.savedAt && <button type="button" className="cc-ghost" disabled={working} onClick={() => void run("reset")}>Back to automatic</button>}
              </span>
            </header>

            <section className="cc-card cc-ws">
              <h3>Posting keywords</h3>
              <ul className="cc-kw" aria-label="Posting keywords">
                {view.keywords.map((k) => (
                  <li key={k.term} className={k.inDraft ? "cc-kw-in" : k.onResume ? "cc-kw-out" : "cc-kw-gap"}>
                    <b>{k.term}</b><span>{k.inDraft ? "in this version" : k.onResume ? "on your resume, not showing" : "not on your resume"}{k.kind === "nice" ? ", nice to have" : ""}</span>
                  </li>
                ))}
              </ul>
              {view.coverage.mustMissing.length > 0 && <p className="cc-draft-block">You can back {view.coverage.mustMissing.join(", ")}, but no line showing it is turned on. Turn one on below.</p>}
              {view.gaps.length > 0 && <p className="cc-hint">Not on your resume: {view.gaps.join(", ")}. The workshop will not write these in. If one is true for you, add it to your saved resume in Setup. If not, the skill builder is the place to close it.</p>}
            </section>

            <section className="cc-card cc-ws">
              <h3>Headline and summary</h3>
              <label className="cc-field"><span className="cc-label">Headline under your name</span>
                <input value={headline} maxLength={120} placeholder={view.headline.master || "For example: QA Automation Engineer"} onChange={(e) => setHeadline(e.target.value)} onBlur={() => { if (headline !== view.headline.value) void change({ headline: headline.trim() || null }) }} />
              </label>
              <div className="cc-segmented cc-views" role="group" aria-label="Summary to use">
                <button type="button" aria-pressed={view.summary.mode === "targeted"} disabled={working} onClick={() => void change({ summaryMode: "targeted" })}>Tuned to this posting</button>
                <button type="button" aria-pressed={view.summary.mode === "master"} disabled={working} onClick={() => void change({ summaryMode: "master" })}>My original</button>
                <button type="button" aria-pressed={view.summary.mode === "custom"} disabled={working} onClick={() => void change({ summaryMode: "custom", summaryText: custom })}>My own wording</button>
              </div>
              {view.summary.mode === "custom" ? (
                <label className="cc-field"><span className="cc-label">Your summary</span>
                  <textarea rows={4} maxLength={1500} value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => { if (custom !== view.summary.custom) void change({ summaryMode: "custom", summaryText: custom }) }} />
                </label>
              ) : <p className="cc-ws-quote">{(view.summary.mode === "master" ? view.summary.master : view.summary.targeted) || "No summary on your saved resume. Add one in Setup, or write one here with My own wording."}</p>}
              {view.summary.flag && <p className="cc-draft-block">Check this: {view.summary.flag}. Keep it only if it is true.</p>}
            </section>

            {view.roles.map((role) => (
              <section key={role.key} className="cc-card cc-ws" data-off={!role.on || undefined}>
                <div className="cc-rule-head">
                  <div className="cc-grow">
                    <h3>{role.section === "work" ? `${role.position}, ${role.name}` : role.name}</h3>
                    <span className="cc-hint">{[role.section === "project" ? "Project" : null, role.dates, `${role.lines.filter((l) => l.on).length} of ${role.lines.length} lines in`].filter(Boolean).join(" · ")}</span>
                  </div>
                  <Switch label="Include" checked={role.on} disabled={working} onChange={() => void change({ rolesOff: toggleIn(view.choices.rolesOff, role.key) })} />
                </div>
                {role.on && (
                  <ul className="cc-lines">
                    {role.lines.map((line) => (
                      <LineRow
                        key={line.id} line={line} hasModel={view.hasModel} busy={working}
                        onToggle={(on) => bullet(line, { on })}
                        onText={(text) => bullet(line, { text, on: true })}
                        onPin={() => void change({ pinned: toggleIn(view.choices.pinned, line.id) })}
                        onSuggest={() => void run("suggest", [line.id])}
                        onDropSuggestion={() => void change({ dropSuggestions: [line.id] })}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}

            {view.skills.length > 0 && (
              <section className="cc-card cc-ws">
                <h3>Skills <span className="cc-hint cc-inline">Tap to leave one off this version. Outlined ones match the posting.</span></h3>
                {view.skills.map((g) => (
                  <div key={g.group} className="cc-ws-skills">
                    <span className="cc-label">{g.group}</span>
                    {g.items.map((s) => (
                      <button key={s.name} type="button" className="cc-pill" data-hit={s.hit || undefined} aria-pressed={s.on} disabled={working} onClick={() => void change({ skillsOff: toggleIn(view.choices.skillsOff, s.name) })}>{s.name}</button>
                    ))}
                  </div>
                ))}
              </section>
            )}

            <section className="cc-card cc-ws">
              <h3>Company research</h3>
              <p className="cc-hint"><b>What the agent reads:</b> this posting, the company's public job board feed (its other open roles), any public pages you list, and your own notes. <b>What it does not read:</b> Glassdoor, LinkedIn and Indeed. Those sites do not allow automated reading, so the app links to them and you paste in what matters.</p>
              <p className="cc-hint"><b>About "winning resumes":</b> other people's successful resumes are not public, and copying them would not be your experience. What the app can measure is the employer's own wording, and which keywords have led to callbacks in your own applications.</p>
              <div className="cc-ws-links">
                {view.links.map((l) => <a key={l.label} className="cc-btn cc-ghost cc-small" href={l.url} target="_blank" rel="noreferrer noopener" title={l.note}>{l.label}</a>)}
              </div>
              <label className="cc-field"><span className="cc-label">Public pages to read (up to 4, one per line)</span>
                <textarea rows={2} value={urls} placeholder="https://company.com/careers/how-we-test" onChange={(e) => setUrls(e.target.value)} />
              </label>
              <label className="cc-field"><span className="cc-label">Your notes</span>
                <textarea rows={4} maxLength={6000} value={notes} placeholder="Paste what you read on Glassdoor or heard from someone who works there." onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== view.notes) void change({ notes }) }} />
              </label>
              <span className="cc-proposal-actions">
                <button type="button" disabled={working} onClick={() => void run("research")}>{busy === "research" ? "Reading…" : view.research ? "Research again" : "Research this company"}</button>
                {view.hasModel && <button type="button" className="cc-ghost" disabled={working} onClick={() => void run("suggest")}>{busy === "suggest" ? "Writing…" : "Suggest wording for my top lines"}</button>}
              </span>
              {!view.hasModel && <p className="cc-hint">No model is connected, so the agent cannot suggest wording or write a summary of the research. Counting the company's keywords still works. Connect one under Controls, Agent.</p>}

              {view.research && (
                <div className="cc-research">
                  <span className="cc-hint">Researched {day(view.research.at)}</span>
                  <ul className="cc-list">
                    {view.research.sources.map((s, i) => (
                      <li key={`${s.label}-${i}`}><span><b>{s.label}</b></span><span className={`cc-hint cc-inline${s.kind === "blocked" || s.kind === "failed" ? " cc-warn-text" : ""}`}>{s.detail}</span></li>
                    ))}
                  </ul>
                  {view.research.brief && (
                    <div className="cc-suggest">
                      <span className="cc-label">What they seem to care about (written by the model from the sources above, so check it)</span>
                      <ul>{view.research.brief.map((b) => <li key={b}>{b}</li>)}</ul>
                    </div>
                  )}
                  {view.research.terms.length > 0 && (
                    <>
                      <span className="cc-label">Their words, most used first</span>
                      <ul className="cc-kw">
                        {view.research.terms.slice(0, 24).map((t) => (
                          <li key={t.term} className={t.onResume ? "cc-kw-in" : "cc-kw-gap"} title={`Seen in: ${t.from.join(", ")}`}>
                            <b>{t.term}</b><span>{t.count} source{t.count === 1 ? "" : "s"}, {t.onResume ? "on your resume" : "not on your resume"}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {view.research.otherRoles.length > 0 && <p className="cc-hint">Other open roles read: {view.research.otherRoles.map((r) => r.title).join(", ")}.</p>}
                </div>
              )}

              {view.rejected.length > 0 && (
                <details className="cc-tokens">
                  <summary>{view.rejected.length} agent suggestion{view.rejected.length === 1 ? "" : "s"} thrown out</summary>
                  <ul className="cc-list">{view.rejected.map((r, i) => <li key={i}><span>{r.text || "(no text)"}</span><span className="cc-hint cc-inline">{r.reason}</span></li>)}</ul>
                </details>
              )}

              <div className="cc-research">
                <span className="cc-label">What has worked for you so far</span>
                {view.ownResults.rows.length === 0
                  ? <p className="cc-hint">Not enough history yet. Once a keyword has shown up in at least 3 applications you sent, its callback rate shows here. {view.ownResults.sent} sent so far.</p>
                  : (
                    <ul className="cc-list">
                      {view.ownResults.rows.map((r) => <li key={r.term}><span><b>{r.term}</b></span><span className="cc-hint cc-inline">{r.callbacks} of {r.sent} applications got a response ({r.rate}%)</span></li>)}
                    </ul>
                  )}
                {view.ownResults.rows.length > 0 && <p className="cc-hint">From your own {view.ownResults.sent} sent applications. Small numbers, so treat it as a hint.</p>}
              </div>
            </section>
          </div>

          <aside className="cc-resume-preview" aria-label="Resume preview">
            <div className="cc-rule-head">
              <span className="cc-label">Live preview</span>
              <button type="button" className="cc-ghost cc-small" aria-pressed={wide} onClick={() => setWide((w) => !w)}>{wide ? "Smaller" : "Bigger"}</button>
            </div>
            <iframe title="Resume preview" srcDoc={view.previewHtml} sandbox="" />
          </aside>
        </div>
      )}
    </div>
  )
}
