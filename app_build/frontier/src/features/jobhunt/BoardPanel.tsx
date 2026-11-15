import { useMemo, useState } from "react"
import type { CommandCenterState, Tab } from "./CommandCenter"
import { applicationAction } from "./jobhunt.functions"
import { STATUS_LABEL } from "./ui"

type Row = CommandCenterState["applications"][number]

const COLUMNS: { key: string; label: string; hint: string; statuses: string[] }[] = [
  { key: "queued", label: "Queued", hint: "Found, not sent yet", statuses: ["saved", "tailored"] },
  { key: "sent", label: "Sent", hint: "Waiting to hear back", statuses: ["applied", "acknowledged"] },
  { key: "screen", label: "Screening", hint: "Assessment or first call", statuses: ["assessment", "screening"] },
  { key: "interview", label: "Interviewing", hint: "In the loop", statuses: ["interviewing"] },
  { key: "offer", label: "Offer", hint: "Offer or accepted", statuses: ["offer", "accepted"] },
  { key: "closed", label: "Closed", hint: "Rejected, no response, withdrawn", statuses: ["rejected", "ghosted", "withdrawn", "bounced"] },
]
const SHOW = 12

/** The switchboard: every application as a card in the column for its stage. */
export function BoardPanel({ state, onNotice, onChanged, onGo }: { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void>; onGo: (tab: Tab) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const columns = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = state.applications.filter((r) => !q || `${r.company} ${r.title} ${r.location}`.toLowerCase().includes(q))
    return COLUMNS.map((c) => ({ ...c, rows: rows.filter((r) => c.statuses.includes(r.status)) }))
  }, [state.applications, query])

  async function move(row: Row, action: string) {
    setBusy(row.id)
    try {
      onNotice((await applicationAction({ data: { id: row.id, action: action as never } })).message)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      await onChanged()
      setBusy(null)
    }
  }

  return (
    <div className="cc-board-wrap">
      <div className="cc-lights" aria-label="Pipeline at a glance">
        {columns.map((c) => (
          <a key={c.key} href={`#cc-col-${c.key}`} className={`cc-light cc-c-${c.key}${c.rows.length ? " cc-lit" : ""}`}>
            <span className="cc-light-n">{c.rows.length}</span>
            <span className="cc-light-k">{c.label}</span>
          </a>
        ))}
        <input type="search" value={query} aria-label="Search the board" placeholder="Search company or title" onChange={(e) => setQuery(e.target.value)} />
      </div>

      {state.applications.length === 0 && <p className="cc-empty-note">Nothing tracked yet. Use Find jobs now, or paste a posting on the Apply tab.</p>}

      <div className="cc-board">
        {columns.map((c) => {
          const shown = open[c.key] ? c.rows : c.rows.slice(0, SHOW)
          return (
            <section key={c.key} id={`cc-col-${c.key}`} className={`cc-col cc-c-${c.key}`} aria-label={`${c.label}, ${c.rows.length}`}>
              <header className="cc-col-head">
                <span className="cc-col-title"><span className="cc-col-dot" aria-hidden="true" />{c.label}</span>
                <span className="cc-col-n">{c.rows.length}</span>
                <span className="cc-hint">{c.hint}</span>
              </header>
              <ul className="cc-col-list">
                {shown.map((r) => (
                  <li key={r.id} className="cc-tile">
                    <div className="cc-tile-top">
                      <strong>{r.company}</strong>
                      {r.fit != null && <span className={`cc-fit${r.fit >= 80 ? " cc-fit-hot" : ""}`} title="Fit score">{r.fit}</span>}
                    </div>
                    <span className="cc-tile-title">{r.title}</span>
                    <div className="cc-tile-foot">
                      <span className="cc-hint">{STATUS_LABEL[r.status] ?? r.status}{r.needsApproval ? ", needs your OK" : ""}</span>
                      {r.needsApproval && <button type="button" className="cc-small" disabled={busy === r.id} onClick={() => void move(r, "approve")}>Approve</button>}
                      {r.canApply && !r.needsApproval && <button type="button" className="cc-small" onClick={() => onGo("apply")}>Apply</button>}
                      {r.nextStatuses.length > 0 && (
                        <select aria-label={`Move ${r.company}`} value="" disabled={busy === r.id} onChange={(e) => { if (e.target.value) void move(r, e.target.value) }}>
                          <option value="">Move to…</option>
                          {r.nextStatuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
                        </select>
                      )}
                    </div>
                  </li>
                ))}
                {c.rows.length === 0 && <li className="cc-col-empty">Empty</li>}
              </ul>
              {c.rows.length > SHOW && (
                <button type="button" className="cc-ghost cc-small" onClick={() => setOpen((o) => ({ ...o, [c.key]: !o[c.key] }))}>{open[c.key] ? "Show fewer" : `Show all ${c.rows.length}`}</button>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
