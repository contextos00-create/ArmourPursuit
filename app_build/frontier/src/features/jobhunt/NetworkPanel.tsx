import { useRef, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { importConnections } from "./jobhunt.functions"
import { Icon, STATUS_LABEL } from "./ui"

/**
 * LinkedIn zone. Everything here comes from the person's own Connections.csv
 * export and from plain search links. Nothing is scraped and nothing is sent.
 */
export function NetworkPanel({ state, onNotice, onChanged }: { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const net = state.network
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const top = Math.max(1, ...net.topCompanies.map((c) => c.n))

  async function upload(f: File | undefined) {
    if (!f) return
    setBusy(true)
    try {
      onNotice((await importConnections({ data: { csv: await f.text() } })).message)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ""
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000)
    } catch {
      onNotice("Copy was blocked by the browser. Select the text and copy it by hand.")
    }
  }

  const withPeople = net.rows.filter((r) => r.people.length)
  const without = net.rows.filter((r) => !r.people.length)

  return (
    <div className="cc-network">
      <div className="cc-mini">
        <div className="cc-stat cc-stat-hero"><div><span className="cc-stat-v">{net.connections}</span><span className="cc-stat-k">Connections imported</span></div></div>
        <div className="cc-stat"><div><span className="cc-stat-v">{net.atTracked}</span><span className="cc-stat-k">People at companies you track</span></div></div>
        <div className="cc-stat"><div><span className="cc-stat-v">{net.companiesWithPeople}</span><span className="cc-stat-k">Tracked companies with someone you know</span></div></div>
        <div className="cc-stat"><div><span className="cc-stat-v">{net.inQa}</span><span className="cc-stat-k">Connections in QA or testing</span></div></div>
      </div>

      <section className="cc-card cc-net-import">
        <div className="cc-grow">
          <h3>{net.connections ? "Update your connections" : "Bring in your LinkedIn connections"}</h3>
          <p className="cc-hint">On LinkedIn: Settings, Data privacy, Get a copy of your data, Connections. Upload the Connections.csv file it emails you. The file stays on the computer and is only used to find people at companies you track.</p>
          <p className="cc-hint">Profile views and post numbers are not here: LinkedIn does not share them with outside apps, and this app does not scrape.</p>
        </div>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        <button type="button" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Importing…" : "Upload Connections.csv"}</button>
      </section>

      {net.topCompanies.length > 0 && (
        <section className="cc-card">
          <h3>Where your network works</h3>
          <p className="cc-hint">Companies with the most of your connections.</p>
          <div className="cc-bars">
            {net.topCompanies.map((c) => (
              <div key={c.company} className="cc-bar-row" title={`${c.company}: ${c.n} connections`}>
                <span className="cc-bar-label">{c.company}</span>
                <span className="cc-bar"><span className="cc-bar-fill" style={{ width: `${(c.n / top) * 100}%` }} /></span>
                <span className="cc-bar-n">{c.n}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {withPeople.length > 0 && <h2>People you know at companies you track</h2>}
      {withPeople.map((r) => (
        <section key={r.id} className="cc-card cc-net-row">
          <header className="cc-app-main">
            <span><strong>{r.company}</strong><span className="cc-app-title cc-hint">{r.title}</span></span>
            <span className={`cc-status cc-status-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
          </header>
          <ul className="cc-list">
            {r.people.map((p) => (
              <li key={p.url}>
                <span><strong>{p.name}</strong> <span className="cc-hint cc-inline">{p.position}</span></span>
                <span className="cc-proposal-actions">
                  {p.ask && <button type="button" className="cc-ghost cc-small" onClick={() => void copy(`${r.id}:${p.url}`, p.ask)}>{copied === `${r.id}:${p.url}` ? "Copied" : "Copy referral ask"}</button>}
                  <a className="cc-btn cc-small" href={p.url} target="_blank" rel="noopener noreferrer"><Icon name="link" /> Open profile</a>
                </span>
              </li>
            ))}
          </ul>
          <QuickLinks row={r} />
        </section>
      ))}

      {without.length > 0 && <h2>Quick connects</h2>}
      {without.length > 0 && (
        <section className="cc-card">
          <p className="cc-hint">No one from your connections file works at these yet. These open a LinkedIn people search in a new tab. You send any message yourself.</p>
          <ul className="cc-list">
            {without.map((r) => (
              <li key={r.id}>
                <span><strong>{r.company}</strong> <span className="cc-hint cc-inline">{r.title}</span></span>
                <QuickLinks row={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {net.rows.length === 0 && <p className="cc-empty-note">Once postings are tracked, each one gets quick links here to find its hiring manager and recruiters.</p>}
    </div>
  )
}

function QuickLinks({ row }: { row: CommandCenterState["network"]["rows"][number] }) {
  return (
    <span className="cc-proposal-actions">
      <a className="cc-btn cc-ghost cc-small" href={row.managerSearch} target="_blank" rel="noopener noreferrer">Find the QA manager</a>
      <a className="cc-btn cc-ghost cc-small" href={row.recruiterSearch} target="_blank" rel="noopener noreferrer">Find recruiters</a>
    </span>
  )
}
