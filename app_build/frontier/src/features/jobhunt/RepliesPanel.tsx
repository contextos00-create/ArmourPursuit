import { useEffect, useMemo, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { composeReply, pauseFollowups, previewReply, replyDraftAction, resetReplyRule, saveReplyRules } from "./jobhunt.functions"
import { Icon, Lever, STATUS_LABEL, Switch } from "./ui"

type Replies = CommandCenterState["replies"]
type Draft = Replies["queue"][number]
type Config = Replies["config"]
type Kind = keyof Config["rules"]
type View = "queue" | "rules" | "exchanges"
type Props = { state: CommandCenterState; onNotice: (m: string) => void; onChanged: () => Promise<void> }

const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })

/** One draft: read it, change it, then send it or deal with it some other way. */
function DraftCard({ draft, replies, onNotice, onChanged }: { draft: Draft; replies: Replies; onNotice: (m: string) => void; onChanged: () => Promise<void> }) {
  const [to, setTo] = useState(draft.to)
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    setTo(draft.to)
    setSubject(draft.subject)
    setBody(draft.body)
  }, [draft.id, draft.to, draft.subject, draft.body])

  const dirty = to !== draft.to || subject !== draft.subject || body !== draft.body
  const open = [...new Set(`${subject}\n${body}`.match(/\[[^\]\n]{3,80}\]/g) ?? [])]
  const hasTo = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(to.trim())
  const blocked = !hasTo ? "Add the email address to send to." : open.length ? `Fill in ${open.join(" and ")} first.` : null
  const mailto = `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  async function run(action: "save" | "send" | "gmail" | "done" | "dismiss" | "snooze", extra: { days?: number } = {}) {
    setBusy(true)
    try {
      const edits = action === "dismiss" || action === "snooze" ? {} : { to: to.trim(), subject, body }
      onNotice((await replyDraftAction({ data: { id: draft.id, action, ...edits, ...extra } })).message)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <article className="cc-card cc-draft" data-ready={draft.ready || undefined}>
      <header className="cc-draft-head">
        <span className={`cc-kind cc-kind-${draft.kind}`}>{draft.kindLabel}</span>
        <div className="cc-grow">
          <strong>{draft.company}</strong>
          <span className="cc-hint">{draft.title}</span>
        </div>
        <span className={draft.ready ? "cc-badge cc-ok" : "cc-badge"}>{draft.ready ? "Ready for you" : `Ready ${when(draft.dueAt)}`}</span>
      </header>
      <p className="cc-hint cc-draft-why"><b>Why:</b> {draft.reason}{draft.isReply ? " This goes out as a reply in the same email thread." : ""}</p>
      <label className="cc-field"><span className="cc-label">To</span><input type="email" value={to} maxLength={200} placeholder="name@company.com" onChange={(e) => setTo(e.target.value)} /></label>
      <label className="cc-field"><span className="cc-label">Subject</span><input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="cc-field"><span className="cc-label">Message</span><textarea rows={Math.min(14, Math.max(6, body.split("\n").length + 1))} maxLength={6000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      {blocked && <p className="cc-draft-block" role="status">{blocked}</p>}
      {confirm ? (
        <div className="cc-confirm" role="alertdialog" aria-label="Confirm send">
          <span>Send this email to <b>{to.trim()}</b> now? It cannot be taken back.</span>
          <span className="cc-proposal-actions">
            <button type="button" disabled={busy} onClick={() => void run("send")}>{busy ? "Sending…" : "Yes, send it"}</button>
            <button type="button" className="cc-ghost" disabled={busy} onClick={() => setConfirm(false)}>Not yet</button>
          </span>
        </div>
      ) : (
        <div className="cc-draft-actions">
          {replies.canSend && <button type="button" disabled={busy || !!blocked} onClick={() => setConfirm(true)}><Icon name="mail" /> Send</button>}
          <a className={`cc-btn${replies.canSend ? " cc-ghost" : ""}`} href={blocked ? undefined : mailto} aria-disabled={!!blocked} onClick={(e) => { if (blocked) e.preventDefault() }}>Open in my mail app</a>
          {replies.canGmailDraft && <button type="button" className="cc-ghost" disabled={busy || !hasTo} onClick={() => void run("gmail")}>Save to Gmail Drafts</button>}
          <button type="button" className="cc-ghost" disabled={busy} onClick={() => void run("done")}>I sent it myself</button>
          {dirty && <button type="button" className="cc-ghost" disabled={busy} onClick={() => void run("save")}>Save edits</button>}
          <span className="cc-grow" />
          <button type="button" className="cc-ghost" disabled={busy} onClick={() => void run("snooze", { days: 2 })}>Snooze 2 days</button>
          <button type="button" className="cc-ghost cc-danger" disabled={busy} onClick={() => void run("dismiss")}>Dismiss</button>
        </div>
      )}
    </article>
  )
}

function Queue({ state, onNotice, onChanged }: Props) {
  const r = state.replies
  const readyNow = r.queue.filter((d) => d.ready)
  const later = r.queue.filter((d) => !d.ready)
  if (!r.queue.length && !r.recent.length) {
    return <p className="cc-empty-note">No drafts yet. When you apply, hear back, finish an interview, or an application goes quiet, the rules write a draft and it lands here for you to read and send.</p>
  }
  return (
    <div className="cc-replies-list">
      {readyNow.length === 0 && <p className="cc-empty-note">Nothing is waiting on you right now.</p>}
      {readyNow.map((d) => <DraftCard key={d.id} draft={d} replies={r} onNotice={onNotice} onChanged={onChanged} />)}
      {later.length > 0 && <h3 className="cc-replies-h">Scheduled <span className="cc-hint cc-inline">Written already. You can still send them early.</span></h3>}
      {later.map((d) => <DraftCard key={d.id} draft={d} replies={r} onNotice={onNotice} onChanged={onChanged} />)}
      {r.recent.length > 0 && (
        <details className="cc-section">
          <summary>Finished ({r.recent.length})</summary>
          <ul className="cc-list">
            {r.recent.map((d) => (
              <li key={d.id}>
                <span><b>{d.company}</b> {d.kindLabel}: {d.subject}</span>
                <span className="cc-hint cc-inline">{d.status === "sent" ? "Sent" : d.status === "gmail" ? "In Gmail Drafts" : d.status === "done" ? "Sent by you" : "Dismissed"}{d.closedAt ? `, ${day(d.closedAt)}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Preview({ kind, rules, state }: { kind: Kind; rules: Config; state: CommandCenterState }) {
  const [appId, setAppId] = useState<string>("")
  const [out, setOut] = useState<{ subject: string; body: string; to: string; forLabel: string } | null>(null)
  const key = JSON.stringify([kind, appId, rules.rules[kind]])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      previewReply({ data: { kind, applicationId: appId || null, rules } }).then((p) => { if (live) setOut(p) }).catch(() => { if (live) setOut(null) })
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key])
  return (
    <div className="cc-preview">
      <label className="cc-field">
        <span className="cc-label">Preview with</span>
        <select value={appId} onChange={(e) => setAppId(e.target.value)}>
          <option value="">A sample application</option>
          {state.replies.threads.map((t) => <option key={t.id} value={t.id}>{t.company}, {t.title}</option>)}
        </select>
      </label>
      {out && (
        <div className="cc-letter">
          <span className="cc-hint">To: {out.to}</span>
          <strong>{out.subject}</strong>
          <pre>{out.body}</pre>
        </div>
      )}
    </div>
  )
}

function Rules({ state, onNotice, onChanged }: Props) {
  const saved = state.replies.config
  const [rules, setRules] = useState<Config>(saved)
  const [saving, setSaving] = useState(false)
  const [openKind, setOpenKind] = useState<Kind | null>(null)
  const savedKey = JSON.stringify(saved)
  useEffect(() => setRules(saved), [savedKey])
  const dirty = JSON.stringify(rules) !== savedKey
  const setRule = (k: Kind, change: Partial<Config["rules"][Kind]>) => setRules((r) => ({ ...r, rules: { ...r.rules, [k]: { ...r.rules[k], ...change } } }))
  const setFollow = (change: Partial<Config["followup"]>) => setRules((r) => ({ ...r, followup: { ...r.followup, ...change } }))
  const f = rules.followup
  const steps = useMemo(() => {
    const out: { day: number; label: string }[] = [{ day: 0, label: "You apply" }]
    for (let i = 0; i < f.max; i++) out.push({ day: f.firstDays + i * f.everyDays, label: `Follow-up ${i + 1} drafted` })
    return out
  }, [f.max, f.firstDays, f.everyDays])

  async function save() {
    setSaving(true)
    try {
      onNotice((await saveReplyRules({ data: rules })).message)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cc-replies-list">
      <section className="cc-card cc-rule-follow">
        <h3>Follow-up schedule</h3>
        <p className="cc-hint">Used when an application is sent and nobody answers. Each follow-up is written as a draft on its day. A reply, a status change, or pausing the application stops the schedule.</p>
        <div className="cc-levers">
          <Lever label="First follow-up after" unit="days" min={2} max={30} value={f.firstDays} onChange={(n) => setFollow({ firstDays: n })} />
          <Lever label="Then again every" unit="days" min={2} max={30} value={f.everyDays} onChange={(n) => setFollow({ everyDays: n })} />
          <Lever label="Most follow-ups per application" min={0} max={5} value={f.max} onChange={(n) => setFollow({ max: n })} hint={f.max === 0 ? "0 turns follow-ups off." : undefined} />
        </div>
        <Switch label="Weekdays only" hint="A follow-up that lands on a weekend waits for Monday." checked={f.weekdaysOnly} onChange={(v) => setFollow({ weekdaysOnly: v })} />
        <ol className="cc-steps" aria-label="What the schedule looks like">
          {steps.map((s) => <li key={s.label}><b>Day {s.day}</b><span>{s.label}</span></li>)}
          <li className="cc-steps-end"><b>Then</b><span>{f.max === 0 ? "No follow-ups" : "It stops. No more nudges."}</span></li>
        </ol>
      </section>

      {state.replies.kinds.map((k) => {
        const key = k.key as Kind
        const rule = rules.rules[key]
        const isOpen = openKind === key
        return (
          <section key={k.key} className="cc-card cc-rule" data-on={rule.on || undefined}>
            <div className="cc-rule-head">
              <Switch label={k.label} hint={k.when} checked={rule.on} onChange={(v) => setRule(key, { on: v })} />
              <button type="button" className="cc-ghost" aria-expanded={isOpen} onClick={() => setOpenKind(isOpen ? null : key)}>{isOpen ? "Close" : "Edit wording"}</button>
            </div>
            {isOpen && (
              <div className="cc-rule-body">
                <div className="cc-rule-edit">
                  {key !== "followup" && <Lever label="Wait before it is ready" unit={`hours ${k.delay}`} min={0} max={72} value={rule.delayHours} onChange={(n) => setRule(key, { delayHours: n })} />}
                  <label className="cc-field"><span className="cc-label">Subject</span><input value={rule.subject} maxLength={200} onChange={(e) => setRule(key, { subject: e.target.value })} /></label>
                  <label className="cc-field"><span className="cc-label">Message</span><textarea rows={10} maxLength={4000} value={rule.body} onChange={(e) => setRule(key, { body: e.target.value })} /></label>
                  <details className="cc-tokens">
                    <summary>Words the app fills in</summary>
                    <dl>{state.replies.tokens.map((t) => <div key={t.token}><dt><code>{t.token}</code></dt><dd>{t.means}</dd></div>)}</dl>
                    <p className="cc-hint">Anything you write in [square brackets] is a note to yourself. A draft cannot be sent until the brackets are filled in.</p>
                  </details>
                  <button
                    type="button"
                    className="cc-ghost"
                    onClick={async () => {
                      try {
                        onNotice((await resetReplyRule({ data: { kind: key } })).message)
                        await onChanged()
                      } catch (e) {
                        onNotice((e as Error).message)
                      }
                    }}
                  >
                    Reset this wording
                  </button>
                </div>
                <Preview kind={key} rules={rules} state={state} />
              </div>
            )}
          </section>
        )
      })}

      {dirty && (
        <div className="cc-savebar">
          <span>Unsaved rule changes</span>
          <span className="cc-proposal-actions">
            <button type="button" className="cc-ghost" onClick={() => setRules(saved)}>Undo</button>
            <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save rules"}</button>
          </span>
        </div>
      )}
    </div>
  )
}

function Exchanges({ state, onNotice, onChanged, onQueue }: Props & { onQueue: () => void }) {
  const threads = state.replies.threads
  const [picked, setPicked] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>("followup")
  const [busy, setBusy] = useState(false)
  const t = threads.find((x) => x.id === picked) ?? threads.at(0)
  if (!t) return <p className="cc-empty-note">Once an application is sent, everything that goes back and forth shows here: when you applied, what they wrote, what you sent, and what is scheduled next.</p>

  async function act(fn: () => Promise<{ message: string }>, then?: () => void) {
    setBusy(true)
    try {
      onNotice((await fn()).message)
      await onChanged()
      then?.()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cc-prep">
      <nav className="cc-prep-pick" aria-label="Pick an application">
        <div className="cc-prep-group">
          {threads.map((x) => (
            <button key={x.id} type="button" className="cc-prep-item" aria-pressed={x.id === t.id} onClick={() => setPicked(x.id)}>
              <strong>{x.company}</strong>
              <span>{x.title}</span>
              <span className="cc-statusline">
                <span className={`cc-status cc-status-${x.status}`}>{STATUS_LABEL[x.status] ?? x.status}</span>
                {x.waiting > 0 && <span className="cc-count">{x.waiting} waiting</span>}
              </span>
            </button>
          ))}
        </div>
      </nav>
      <div className="cc-prep-body">
        <header className="cc-card cc-thread-head">
          <div className="cc-grow">
            <h3 className="cc-prep-title">{t.company}</h3>
            <span className="cc-hint">{t.title}{t.contact ? `. Contact: ${t.contact}` : ". No contact email on file yet."}</span>
          </div>
          <div className="cc-next" data-on={t.next.at != null || undefined}>
            <span className="cc-label">Next follow-up</span>
            <span>{t.next.at != null ? `Number ${t.next.n} will be drafted ${day(t.next.at)}` : "None scheduled"}</span>
            <span className="cc-hint">{t.next.why}</span>
          </div>
        </header>
        <section className="cc-card cc-thread-tools">
          <Switch label="Pause follow-ups for this one" hint="Use it when you have talked by phone or want to leave it alone." checked={t.paused} disabled={busy} onChange={(v) => void act(() => pauseFollowups({ data: { id: t.id, paused: v } }))} />
          <div className="cc-draft-actions">
            <select value={kind} aria-label="Kind of message" onChange={(e) => setKind(e.target.value as Kind)}>
              {state.replies.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={() => void act(() => composeReply({ data: { id: t.id, kind } }), onQueue)}>Draft one now</button>
          </div>
        </section>
        <ol className="cc-thread">
          {t.items.map((i, n) => (
            <li key={`${i.at}-${n}`} className={`cc-thread-item cc-thread-${i.type}`}>
              <span className="cc-thread-dot" aria-hidden="true" />
              <div>
                <span className="cc-thread-meta">{{ status: "Tracker", in: "They wrote", out: "You sent", draft: "Waiting on you", skipped: "Skipped" }[i.type]} · {when(i.at)}</span>
                <strong>{i.title}</strong>
                {i.detail && <p>{i.detail}</p>}
              </div>
            </li>
          ))}
          {t.items.length === 0 && <li className="cc-hint">Nothing recorded yet.</li>}
        </ol>
      </div>
    </div>
  )
}

/** Reply workshop: the queue of drafts, the rules that write them, and each application's exchange. */
export function RepliesPanel({ state, onNotice, onChanged }: Props) {
  const r = state.replies
  const [view, setView] = useState<View>("queue")
  const [busy, setBusy] = useState(false)
  const readyNow = r.queue.filter((d) => d.ready).length

  async function master(enabled: boolean) {
    setBusy(true)
    try {
      onNotice((await saveReplyRules({ data: { ...r.config, enabled } })).message)
      await onChanged()
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cc-replies">
      <section className="cc-card cc-replies-top">
        <div className="cc-grow">
          <h3>Reply workshop</h3>
          <p className="cc-hint"><b>Nothing here sends on its own.</b> The rules write drafts and schedule follow-ups. You read each one and press Send yourself.</p>
          <p className="cc-hint">{r.canSend ? "Your mailbox is connected, so Send works from this screen." : "Your mailbox is not connected on the computer. Drafts open in your own mail app instead, or you can copy them."}</p>
        </div>
        <Switch label="Write drafts for me" hint={r.config.enabled ? "On" : "Off. No replies or follow-ups are drafted."} checked={r.config.enabled} disabled={busy} onChange={(v) => void master(v)} />
      </section>
      <div className="cc-segmented cc-replies-views" role="group" aria-label="Reply workshop view">
        <button type="button" aria-pressed={view === "queue"} onClick={() => setView("queue")}>Queue{readyNow > 0 ? ` (${readyNow})` : ""}</button>
        <button type="button" aria-pressed={view === "rules"} onClick={() => setView("rules")}>Rules and wording</button>
        <button type="button" aria-pressed={view === "exchanges"} onClick={() => setView("exchanges")}>Exchanges</button>
      </div>
      {view === "queue" && <Queue state={state} onNotice={onNotice} onChanged={onChanged} />}
      {view === "rules" && <Rules state={state} onNotice={onNotice} onChanged={onChanged} />}
      {view === "exchanges" && <Exchanges state={state} onNotice={onNotice} onChanged={onChanged} onQueue={() => setView("queue")} />}
    </div>
  )
}
