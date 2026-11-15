import { useCallback, useEffect, useRef, useState } from "react"
import { ApplyPanel } from "./ApplyPanel"
import { BoardPanel } from "./BoardPanel"
import { ControlsPanel } from "./ControlsPanel"
import { DashboardPanel } from "./DashboardPanel"
import { NetworkPanel } from "./NetworkPanel"
import { Bell } from "./NotifyPanel"
import { PrepPanel } from "./PrepPanel"
import { RepliesPanel } from "./RepliesPanel"
import { ResumePanel } from "./ResumePanel"
import { SetupWizard } from "./SetupWizard"
import { Icon, PageHead, openDocument  } from "./ui"
import type {IconName} from "./ui";
import {
  applyAgentProposal,
  clearAgentChat,
  dismissAgentProposal,
  getAccess,
  getCommandCenter,
  readJobDocument,
  runAutomation,
  sendAgentMessage,
  unlockCommandCenter,
} from "./jobhunt.functions"
import logoUrl from "./armour-pursuit-logo.png"
import "./command-center.css"

export type CommandCenterState = Awaited<ReturnType<typeof getCommandCenter>>
type Turn = CommandCenterState["history"][number]
type Proposal = CommandCenterState["proposals"][number]
export type Tab = "dashboard" | "board" | "apply" | "resume" | "prep" | "replies" | "network" | "controls" | "chat"

const STARTERS = [
  "What should I focus on this week?",
  "Which one skill would open up the most postings?",
  "Help me answer the open application questions.",
  "Is my search too narrow or too broad?",
]

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "board", label: "Board", icon: "board" },
  { id: "apply", label: "Apply", icon: "apply" },
  { id: "resume", label: "Resume", icon: "resume" },
  { id: "prep", label: "Prep", icon: "prep" },
  { id: "replies", label: "Replies", icon: "mail" },
  { id: "network", label: "LinkedIn", icon: "network" },
  { id: "controls", label: "Controls", icon: "controls" },
  { id: "chat", label: "Chat", icon: "chat" },
]

const FULL_KEY = "jh-full-view"

export default function CommandCenter() {
  const [state, setState] = useState<CommandCenterState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [locked, setLocked] = useState<{ remoteEnabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState("")
  const [tab, setTab] = useState<Tab>("dashboard")
  const [notice, setNotice] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)

  // Full view hides the docked chat so the current screen gets the whole width.
  useEffect(() => {
    try {
      setFull(localStorage.getItem(FULL_KEY) === "1")
    } catch {
      /* storage can be blocked; full view just starts off */
    }
  }, [])
  function toggleFull() {
    setFull((cur) => {
      try {
        localStorage.setItem(FULL_KEY, cur ? "0" : "1")
      } catch {
        /* not remembered, still works */
      }
      return !cur
    })
    setTab((t) => (t === "chat" ? "dashboard" : t))
  }
  /** Chat is docked beside the page on a wide screen, and its own tab otherwise. */
  function go(next: Tab) {
    if (next === "chat" && !full && window.matchMedia("(min-width: 901px)").matches) {
      composeRef.current?.focus()
      return
    }
    setTab(next)
  }

  const refresh = useCallback(async () => {
    try {
      const access = await getAccess()
      if (!access.authed) {
        setLocked({ remoteEnabled: access.remoteEnabled })
        setState(null)
        setError(null)
        return
      }
      setLocked(null)
      setState(await getCommandCenter())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A new install opens on the setup form, and stays there until it is finished or closed.
  const needsSetup = state ? !state.setup.done : false
  useEffect(() => {
    if (needsSetup) setSetupOpen(true)
  }, [needsSetup])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [state?.history.length, busy, tab])

  // Document links inside the dashboard iframe post their path here.
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.data?.type !== "jh-doc" || typeof event.data.path !== "string") return
      try {
        const doc = await readJobDocument({ data: { path: event.data.path } })
        openDocument(doc)
      } catch (e) {
        setNotice((e as Error).message)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  async function send(text: string) {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setDraft("")
    setState((s) => (s ? { ...s, history: [...s.history, { role: "user", content: message }] } : s))
    try {
      await sendAgentMessage({ data: { text: message } })
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  async function act(work: () => Promise<{ message: string }>) {
    setBusy(true)
    try {
      setNotice((await work()).message)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  if (locked) return <Lock remoteEnabled={locked.remoteEnabled} onUnlocked={refresh} />
  if (error) {
    return (
      <main className="cc cc-center">
        <h1 className="cc-brand"><img src={logoUrl} alt="Armour Pursuit. Your whole job search, handled." width={880} height={248} /></h1>
        <p>{error}</p>
        <button onClick={() => void refresh()}>Try again</button>
      </main>
    )
  }
  if (!state) return <main className="cc"><p className="cc-muted">Loading…</p></main>

  if (setupOpen) {
    return (
      <main className="cc cc-setup-page">
        <h1 className="cc-brand"><img src={logoUrl} alt="Armour Pursuit. Your whole job search, handled." width={880} height={248} /></h1>
        {notice && (
          <div className="cc-notice" role="status">
            <span>{notice}</span>
            <button className="cc-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">Close</button>
          </div>
        )}
        <SetupWizard state={state} onNotice={setNotice} onChanged={refresh} onClose={() => setSetupOpen(false)} />
      </main>
    )
  }

  const hasModel = state.config.hasKey || state.config.provider === "openai-compatible"
  const waiting = state.applications.filter((a) => a.needsApproval).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const apps = state.applications
  const readyToSend = apps.filter((a) => a.canApply && !a.needsApproval).length
  const talking = apps.filter((a) => ["assessment", "screening", "interviewing", "offer", "accepted"].includes(a.status)).length
  const draftsReady = state.replies.queue.filter((d) => d.ready).length
  const liveRoles = state.prep.filter((p) => p.live).length

  return (
    <main className="cc" data-tab={tab} data-full={full ? "1" : undefined}>
      <header className="cc-head">
        <div>
          <h1 className="cc-brand"><img src={logoUrl} alt="Armour Pursuit. Your whole job search, handled." width={880} height={248} /></h1>
          <p className="cc-muted cc-statusline">
            {state.paused ? <span className="cc-badge cc-badge-warn"><span className="cc-pulse" aria-hidden="true" />Automation paused</span> : <span className="cc-badge cc-badge-live"><span className="cc-pulse" aria-hidden="true" />Automation running</span>}
            <span className="cc-badge">{hasModel ? `Agent: ${state.config.model || "no model set"}` : "Agent: not set up"}</span>
          </p>
        </div>
        <div className="cc-actions">
          <button className="cc-ghost" disabled={busy} onClick={() => void act(() => runAutomation({ data: { action: state.paused ? "resume" : "pause" } }))}><Icon name={state.paused ? "play" : "pause"} /> <span className="cc-btn-label">{state.paused ? "Resume" : "Pause"}</span></button>
          <button className="cc-hero" disabled={busy || state.paused} onClick={() => void act(() => runAutomation({ data: { action: "discover" } }))}><Icon name="search" /> Find jobs now</button>
          <button className="cc-ghost" onClick={() => void refresh()} aria-label="Refresh"><Icon name="refresh" /></button>
          <Bell state={state} />
          <button className="cc-ghost cc-fullbtn" aria-pressed={full} onClick={toggleFull}><Icon name={full ? "chat" : "expand"} /> {full ? "Show chat" : "Full view"}</button>
        </div>
      </header>

      {notice && (
        <div className="cc-notice" role="status">
          <span>{notice}</span>
          <button className="cc-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">Close</button>
        </div>
      )}

      <nav className="cc-tabs" aria-label="View">
        {TABS.map((t) => (
          <button key={t.id} className={`cc-tab cc-tab-${t.id}`} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            <span className="cc-tab-label">{t.label}</span>
            {t.id === "apply" && waiting > 0 && <span className="cc-count">{waiting}</span>}
            {t.id === "prep" && state.prep.some((p) => p.live) && <span className="cc-count">{state.prep.filter((p) => p.live).length}</span>}
            {t.id === "replies" && state.replies.queue.some((d) => d.ready) && <span className="cc-count">{state.replies.queue.filter((d) => d.ready).length}</span>}
            {t.id === "chat" && state.proposals.length > 0 && <span className="cc-count">{state.proposals.length}</span>}
          </button>
        ))}
      </nav>

      <div className="cc-grid">
        <section className="cc-main" aria-label={TABS.find((t) => t.id === tab)?.label}>
          <div className="cc-pane cc-scroll" hidden={tab !== "dashboard" && tab !== "chat"}>
            <DashboardPanel state={state} onGo={go} onNotice={setNotice} />
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "apply"}>
            <div className="cc-page">
              <PageHead eyebrow="Apply" title="You press Submit." detail={`${readyToSend} ready to send${waiting ? `, ${waiting} waiting for your OK` : ""}.`} />
              <ApplyPanel state={state} visible={tab === "apply"} onNotice={setNotice} onChanged={refresh} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "board"}>
            <div className="cc-page">
              <PageHead eyebrow="Board" title="Every application, by stage." detail={`${apps.length} tracked, ${talking} in conversation.`} />
              <BoardPanel state={state} onNotice={setNotice} onChanged={refresh} onGo={go} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "prep"}>
            <div className="cc-page">
              <PageHead eyebrow="Prep" title="Walk in ready." detail={liveRoles ? `${plural(liveRoles, "role", "roles")} at interview stage.` : "No interviews yet, so get ahead."} />
              <PrepPanel state={state} onNotice={setNotice} onChanged={refresh} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "resume"}>
            <div className="cc-page">
              <PageHead eyebrow="Resume" title="One resume per posting." detail="Built only from your own lines." />
              <ResumePanel state={state} visible={tab === "resume"} onNotice={setNotice} onChanged={refresh} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "replies"}>
            <div className="cc-page">
              <PageHead eyebrow="Replies" title="You press Send." detail={draftsReady ? `${plural(draftsReady, "draft", "drafts")} ready for you.` : "No drafts waiting."} />
              <RepliesPanel state={state} onNotice={setNotice} onChanged={refresh} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "network"}>
            <div className="cc-page">
              <PageHead eyebrow="LinkedIn" title="People who can open a door." detail={`${state.network.atTracked} at companies you track.`} />
              <NetworkPanel state={state} onNotice={setNotice} onChanged={refresh} />
            </div>
          </div>
          <div className="cc-pane cc-scroll" hidden={tab !== "controls"}>
            <div className="cc-page">
              <PageHead eyebrow="Controls" title="Your rules." detail={state.paused ? "Automation is paused." : "Automation is running."} />
              <ControlsPanel state={state} onNotice={setNotice} onChanged={refresh} onGo={go} onSetup={() => setSetupOpen(true)} />
            </div>
          </div>
        </section>

        <section className="cc-chat" aria-label="Chat with your agent">
          <header className="cc-agent-head">
            <span className="cc-agent-mark" data-busy={busy || undefined} aria-hidden="true"><img src="/armour-pursuit-192.png" alt="" width={38} height={38} /></span>
            <span className="cc-agent-id">
              <strong>Your agent</strong>
              <span className="cc-hint">{hasModel ? state.config.model || "Model not named" : "No model connected"}</span>
            </span>
            <span className={`cc-agent-state${busy ? " cc-agent-busy" : ""}`} role="status">{busy ? "Thinking" : hasModel ? "Ready" : "Offline"}</span>
          </header>
          <div className="cc-messages" ref={listRef}>
            {state.history.length === 0 && (
              <div className="cc-empty">
                <h3>What should we work on?</h3>
                <p>{hasModel ? "Ask about strategy, which postings to chase, or the questions an application is waiting on. Suggested changes show up as cards you approve." : "Add your model and key under Controls, Agent (on the computer). Then ask about strategy, postings, or open application questions."}</p>
                <div className="cc-starters">
                  {STARTERS.map((s) => (
                    <button key={s} className="cc-chip" disabled={busy || !hasModel} onClick={() => void send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {state.history.map((t: Turn, i: number) => (
              <div key={i} className={`cc-msg cc-${t.role}`} style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}>{t.content}</div>
            ))}
            {busy && <div className="cc-msg cc-assistant cc-typing" role="status" aria-label="The agent is working"><span /><span /><span /></div>}
          </div>

          {state.proposals.length > 0 && (
            <div className="cc-proposals" aria-label="Suggested changes">
              <h2>Suggested changes</h2>
              {state.proposals.map((p: Proposal) => (
                <div key={p.id} className="cc-proposal">
                  <span className="cc-proposal-text"><span className="cc-proposal-kind">{p.action.type === "start_apply" ? "Start an application" : "Setting"}</span>{p.summary}</span>
                  <span className="cc-proposal-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const r = await applyAgentProposal({ data: { id: p.id } })
                          if (p.action.type === "start_apply") setTab("apply")
                          return r
                        })
                      }
                    >
                      Apply
                    </button>
                    <button className="cc-ghost" disabled={busy} onClick={async () => { await dismissAgentProposal({ data: { id: p.id } }); await refresh() }}>Dismiss</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <form className="cc-compose" onSubmit={(e) => { e.preventDefault(); void send(draft) }}>
            <textarea
              ref={composeRef}
              value={draft}
              aria-label="Message your agent"
              placeholder={hasModel ? "Message your agent" : "Set up a model first (Controls, Agent)"}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
            />
            <div className="cc-compose-row">
              <button type="button" className="cc-ghost" disabled={busy || state.history.length === 0} onClick={async () => { await clearAgentChat(); await refresh() }}>New chat</button>
              <button type="submit" disabled={busy || !draft.trim()}>Send</button>
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}

function Lock({ remoteEnabled, onUnlocked }: { remoteEnabled: boolean; onUnlocked: () => Promise<void> }) {
  const [passcode, setPasscode] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <main className="cc cc-center">
      <h1 className="cc-brand"><img src={logoUrl} alt="Armour Pursuit. Your whole job search, handled." width={880} height={248} /></h1>
      {remoteEnabled ? (
        <form
          className="cc-lock"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await unlockCommandCenter({ data: { passcode } })
              setErr(null)
              await onUnlocked()
            } catch (x) {
              setErr((x as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="cc-field">
            <span className="cc-label">Passcode</span>
            <input type="password" autoComplete="current-password" autoFocus value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          </label>
          {err && <p className="cc-err" role="alert">{err}</p>}
          <button type="submit" disabled={busy || !passcode}>Unlock</button>
        </form>
      ) : (
        <p>Phone access is off. Turn it on from the computer: open this page there, then Controls, Phone access.</p>
      )}
    </main>
  )
}
