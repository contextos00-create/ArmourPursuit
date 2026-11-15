import { useEffect, useMemo, useRef, useState } from "react"
import {
  addJobPosting,
  answerPendingQuestion,
  applicationAction,
  getApplySession,
  sendApplyInput,
  startApplySession,
  stopApplySession,
  submitApplySession,
} from "./jobhunt.functions"
import type { CommandCenterState } from "./CommandCenter"

type Row = CommandCenterState["applications"][number]
type View = Awaited<ReturnType<typeof getApplySession>>
type Filter = "ready" | "approve" | "active" | "all"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "ready", label: "Ready to apply" },
  { id: "approve", label: "Needs your OK" },
  { id: "active", label: "In progress" },
  { id: "all", label: "All" },
]
const ACTIVE = ["applied", "acknowledged", "assessment", "screening", "interviewing", "offer", "bounced"]
const KEYS = ["Tab", "Enter", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "PageUp", "PageDown", "Home", "End"]

export function ApplyPanel({ state, visible, onNotice, onChanged }: { state: CommandCenterState; visible: boolean; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [view, setView] = useState<View | null>(null)
  const [filter, setFilter] = useState<Filter>("ready")
  const [query, setQuery] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const wasActive = useRef(false)

  // Poll the live run. Pictures only while this tab is on screen.
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      let active = false
      try {
        const v = await getApplySession({ data: { image: visible } })
        if (stop) return
        active = v.active
        setView((old) => (!visible && old?.image ? { ...v, image: old.image } : v))
        if (wasActive.current && !v.active) void onChanged()
        wasActive.current = v.active
      } catch {
        /* keep the last view; the next tick retries */
      }
      if (!stop) timer = setTimeout(tick, active ? (visible ? 1200 : 4000) : 6000)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [visible])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return state.applications.filter((r) => {
      if (q && !`${r.company} ${r.title} ${r.location} ${r.code}`.toLowerCase().includes(q)) return false
      if (filter === "ready") return r.canApply && !r.needsApproval
      if (filter === "approve") return r.needsApproval
      if (filter === "active") return ACTIVE.includes(r.status)
      return true
    })
  }, [state.applications, filter, query])

  const counts = useMemo(
    () => ({
      ready: state.applications.filter((r) => r.canApply && !r.needsApproval).length,
      approve: state.applications.filter((r) => r.needsApproval).length,
      active: state.applications.filter((r) => ACTIVE.includes(r.status)).length,
      all: state.applications.length,
    }),
    [state.applications]
  )

  async function run(work: () => Promise<{ message: string } | { ok: boolean }>) {
    setBusy(true)
    try {
      const r = await work()
      if ("message" in r) onNotice(r.message)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  const [dismissed, setDismissed] = useState<string | null>(null)
  const runKey = view ? `${view.applicationId}:${view.log[0]?.at ?? 0}` : ""
  const live = view && view.state !== "idle" && (view.active || dismissed !== runKey) ? view : null

  return (
    <div className="cc-apply">
      {live && <LiveRun view={live} onNotice={onNotice} onDone={onChanged} onDismiss={() => setDismissed(runKey)} />}

      <form
        className="cc-addrow cc-card"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            const r = await addJobPosting({ data: { url: url.trim() } })
            setUrl("")
            return r
          })
        }}
      >
        <input type="url" value={url} aria-label="Posting address" placeholder="Paste a job posting address (https://...)" onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" disabled={busy || !/^https:\/\/\S+/.test(url.trim())}>Add posting</button>
      </form>

      <div className="cc-filters" role="group" aria-label="Filter applications">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="cc-pill" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="cc-count">{counts[f.id]}</span>
          </button>
        ))}
        <input type="search" value={query} aria-label="Search applications" placeholder="Search" onChange={(e) => setQuery(e.target.value)} />
      </div>

      {rows.length === 0 && <p className="cc-muted cc-pad">{state.applications.length === 0 ? "No applications yet. Add a posting above or run a search." : "Nothing in this list."}</p>}
      <ul className="cc-apps">
        {rows.map((r) => (
          <AppRow key={r.id} row={r} busy={busy || !!live?.active} run={run} onNotice={onNotice} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  )
}

function AppRow({ row, busy, run, onNotice, onChanged }: { row: Row; busy: boolean; run: (w: () => Promise<{ message: string } | { ok: boolean }>) => Promise<void>; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  return (
    <li className="cc-app">
      <div className="cc-app-main">
        <div>
          <strong>{row.company}</strong>
          <span className="cc-app-title">{row.title}</span>
          <span className="cc-hint">{[row.location, row.fit !== null ? `fit ${row.fit}` : "", `code ${row.code}`].filter(Boolean).join(" · ")}</span>
        </div>
        <span className={`cc-status cc-status-${row.status}`}>{row.status}</span>
      </div>
      <div className="cc-app-actions">
        {row.needsApproval && <button type="button" disabled={busy} onClick={() => void run(() => applicationAction({ data: { id: row.id, action: "approve" } }))}>Approve</button>}
        {row.needsApproval && <button type="button" className="cc-ghost" disabled={busy} onClick={() => void run(() => applicationAction({ data: { id: row.id, action: "skip" } }))}>Skip</button>}
        {row.canApply && !row.needsApproval && <button type="button" disabled={busy} onClick={() => void run(() => startApplySession({ data: { id: row.id, narrow: window.innerWidth < 700 } }))}>Fill the form</button>}
        {row.url && <a className="cc-link" href={row.url} target="_blank" rel="noreferrer noopener">Open posting</a>}
        {row.nextStatuses.length > 0 && (
          <select
            aria-label={`Change status of ${row.company}`}
            value=""
            disabled={busy}
            onChange={(e) => {
              const action = e.target.value
              if (action) void run(() => applicationAction({ data: { id: row.id, action: action as Row["status"] } }))
            }}
          >
            <option value="">Mark as…</option>
            {row.nextStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>
      {row.pending.length > 0 && (
        <div className="cc-pending">
          <span className="cc-label">Form questions waiting on you</span>
          {row.pending.map((q, i) => (
            <form
              key={q}
              className="cc-addrow"
              onSubmit={async (e) => {
                e.preventDefault()
                try {
                  // Answering removes this question, so the rest shift up: always send the current position.
                  const r = await answerPendingQuestion({ data: { id: row.id, n: i + 1, answer: (answers[i] ?? "").trim() } })
                  onNotice(r.message)
                  setAnswers({})
                } catch (x) {
                  onNotice((x as Error).message)
                }
                await onChanged()
              }}
            >
              <label className="cc-grow">
                <span className="cc-hint">{q}</span>
                <input value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))} placeholder="Your answer (saved for next time)" />
              </label>
              <button type="submit" className="cc-ghost" disabled={!(answers[i] ?? "").trim()}>Save</button>
            </form>
          ))}
        </div>
      )}
    </li>
  )
}

const STATE_TEXT: Record<string, string> = {
  starting: "Opening the form",
  filling: "Filling the form",
  review: "Your turn: review and submit",
  applied: "Applied",
  ended: "Ended",
  failed: "Stopped with a problem",
}

function LiveRun({ view, onNotice, onDone, onDismiss }: { view: View; onNotice: (m: string) => void; onDone: () => Promise<void>; onDismiss: () => void }) {
  const [text, setText] = useState("")
  const [confirm, setConfirm] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const ready = view.state === "review"

  const [choice, setChoice] = useState<NonNullable<Awaited<ReturnType<typeof sendApplyInput>>["select"]> | null>(null)

  // Inputs go one at a time, in order.
  const send = (ev: Parameters<typeof sendApplyInput>[0]["data"]) => {
    queue.current = queue.current
      .then(() => sendApplyInput({ data: ev }))
      .then((r) => setChoice(r.select ?? null))
      .catch((e) => onNotice((e as Error).message))
  }

  return (
    <section className="cc-live cc-card" aria-label="Live application">
      <header className="cc-live-head">
        <div>
          <strong>{view.company}</strong> <span className="cc-app-title">{view.title}</span>
          <p className="cc-muted" role="status">{STATE_TEXT[view.state] ?? view.state}{view.filled ? ` · ${view.filled} fields filled` : ""}{view.windowVisible ? " · window open on the computer" : ""}</p>
        </div>
        {view.active && (
          <button type="button" className="cc-ghost" onClick={async () => { await stopApplySession(); await onDone() }}>Stop</button>
        )}
        {!view.active && <button type="button" className="cc-ghost" onClick={onDismiss}>Close</button>}
      </header>

      {view.captcha && ready && <p className="cc-banner">There is a CAPTCHA on this form. Solve it yourself by tapping it in the picture.</p>}

      {!view.active ? null : view.image ? (
        <div className="cc-screen">
          <img
            src={`data:image/jpeg;base64,${view.image}`}
            alt={`Live picture of the ${view.company} application form`}
            tabIndex={ready ? 0 : -1}
            draggable={false}
            onClick={(e) => {
              if (!ready) return
              const box = e.currentTarget.getBoundingClientRect()
              send({ type: "click", x: ((e.clientX - box.left) / box.width) * view.width, y: ((e.clientY - box.top) / box.height) * view.height })
              e.currentTarget.focus()
            }}
            onWheel={(e) => ready && send({ type: "scroll", dy: Math.max(-2000, Math.min(2000, e.deltaY)) })}
            onKeyDown={(e) => {
              if (!ready || e.metaKey || e.ctrlKey || e.altKey) return
              if (KEYS.includes(e.key)) {
                e.preventDefault()
                send({ type: "key", key: e.key })
              } else if (e.key === " ") {
                e.preventDefault()
                send({ type: "type", text: " " })
              } else if (e.key.length === 1) {
                e.preventDefault()
                send({ type: "type", text: e.key })
              }
            }}
          />
        </div>
      ) : (
        <p className="cc-muted cc-pad">Waiting for the first picture…</p>
      )}

      {ready && choice && (
        <div className="cc-pending" role="group" aria-label="Dropdown options">
          <span className="cc-label">Pick an option for this dropdown</span>
          <div className="cc-keys">
            {choice.options.map((o) => (
              <button key={o.value} type="button" className="cc-pill" aria-pressed={o.value === choice.current} onClick={() => send({ type: "select", x: choice.x, y: choice.y, value: o.value })}>
                {o.text || "(blank)"}
              </button>
            ))}
            <button type="button" className="cc-ghost cc-small" onClick={() => setChoice(null)}>Cancel</button>
          </div>
        </div>
      )}

      {ready && (
        <>
          <p className="cc-hint">Tap a field in the picture, then type here. On a computer you can also click the picture and type directly.</p>
          <form
            className="cc-addrow"
            onSubmit={(e) => {
              e.preventDefault()
              if (text) send({ type: "type", text })
              setText("")
            }}
          >
            <input value={text} aria-label="Text to type into the form" placeholder="Text to type into the selected field" onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="cc-ghost" disabled={!text}>Type</button>
          </form>
          <div className="cc-keys" role="group" aria-label="Form keys">
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "scroll", dy: -400 })}>Scroll up</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "scroll", dy: 400 })}>Scroll down</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "key", key: "Tab" })}>Tab</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "key", key: "Enter" })}>Enter</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "key", key: "Backspace" })}>Backspace</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "key", key: "ArrowDown" })}>Down</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "key", key: "ArrowUp" })}>Up</button>
            <button type="button" className="cc-ghost cc-small" onClick={() => send({ type: "viewport", narrow: view.width > 600 })}>{view.width > 600 ? "Phone layout" : "Computer layout"}</button>
          </div>
          <div className="cc-submit">
            {confirm ? (
              <>
                <span>Send this application to {view.company}?</span>
                <button
                  type="button"
                  onClick={async () => {
                    setConfirm(false)
                    try {
                      onNotice((await submitApplySession()).message)
                    } catch (e) {
                      onNotice((e as Error).message)
                    }
                  }}
                >
                  Yes, submit
                </button>
                <button type="button" className="cc-ghost" onClick={() => setConfirm(false)}>Not yet</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirm(true)}>Submit application</button>
            )}
          </div>
        </>
      )}

      {view.unanswered.length > 0 && ready && (
        <div className="cc-pending">
          <span className="cc-label">Left for you on this form</span>
          <ul>
            {view.unanswered.map((u) => <li key={u.label}>{u.label}{u.required ? "" : " (optional)"}</li>)}
          </ul>
        </div>
      )}

      <ol className="cc-log" aria-label="What happened">
        {view.log.map((l, i) => <li key={`${l.at}-${i}`}><time>{new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time> {l.text}</li>)}
      </ol>
    </section>
  )
}
