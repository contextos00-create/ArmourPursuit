import { useState } from "react"
import type { CommandCenterState, Tab } from "./CommandCenter"
import { runAutomation } from "./jobhunt.functions"
import { Icon, Lever, Ring, Spark, Switch } from "./ui"

type Settings = CommandCenterState["settings"]

const WINDOW_LABEL: Record<Settings["applyWindow"], string> = { auto: "Auto", visible: "Show", hidden: "Hide" }

/**
 * Top of the Controls tab: the headline numbers, the model lane, and the
 * switches and sliders used most. Changes here save as soon as they are made.
 */
export function MissionControl({ state, settings, onQuick, onNotice, onChanged, onGo }: {
  state: CommandCenterState
  settings: Settings
  onQuick: <TKey extends keyof Settings>(key: TKey, value: Settings[TKey]) => Promise<void>
  onNotice: (m: string) => void
  onChanged: () => Promise<void>
  onGo: (tab: Tab) => void
}) {
  const m = state.metrics
  const [busy, setBusy] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const hasModel = state.config.hasKey || state.config.provider === "openai-compatible"
  const lastReply = [...state.history].reverse().find((t) => t.role === "assistant")?.content ?? ""
  const waiting = state.applications.filter((a) => a.needsApproval).length
  const ready = state.applications.filter((a) => a.canApply && !a.needsApproval).length
  const total = Math.max(1, m.buckets.reduce((n, b) => n + b.n, 0))

  async function run(action: "pause" | "resume" | "discover" | "inbox") {
    setBusy(true)
    try {
      onNotice((await runAutomation({ data: { action } })).message)
    } catch (e) {
      onNotice((e as Error).message)
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  // The three fit thresholds, drawn as zones on one 0 to 100 scale.
  const ask = Math.min(settings.approvalAt, settings.autoTailorAt)
  const tailor = Math.max(settings.approvalAt, settings.autoTailorAt)
  const hot = Math.max(tailor, settings.hotScore)

  return (
    <section className="cc-mission" aria-label="Mission control">
      <div className="cc-mini" aria-label="Today at a glance">
        <div className="cc-stat cc-stat-hero">
          <Ring share={m.foundToday / Math.max(1, settings.dailyTarget)} label={`${m.foundToday} of ${settings.dailyTarget} found today`} />
          <div><span className="cc-stat-v">{m.foundToday}<small> of {settings.dailyTarget}</small></span><span className="cc-stat-k">Found today</span></div>
        </div>
        <div className="cc-stat"><div><span className="cc-stat-v">{m.applied}</span><span className="cc-stat-k">Applied</span></div><span title={`${m.sentThisWeek} sent this week`}><Spark values={m.weeks} /></span></div>
        <div className="cc-stat"><Ring share={m.responseRate / 100} /><div><span className="cc-stat-v">{m.responseRate}%</span><span className="cc-stat-k">Response rate</span></div></div>
        <div className="cc-stat"><div><span className="cc-stat-v">{m.interviews}</span><span className="cc-stat-k">Reached interview</span></div></div>
        <div className="cc-stat"><div><span className="cc-stat-v">{m.offers}</span><span className="cc-stat-k">Offers</span></div></div>
        <button type="button" className="cc-stat cc-stat-link" onClick={() => onGo("dashboard")}><Icon name="expand" /><span className="cc-stat-k">Full dashboard</span></button>
      </div>

      {m.tracked > 0 && (
        <div className="cc-mini-seg">
          <div className="cc-seg" role="img" aria-label={m.buckets.map((b) => `${b.label} ${b.n}`).join(", ")}>
            {m.buckets.filter((b) => b.n).map((b) => <span key={b.key} className={`cc-k-${b.key}`} style={{ flex: b.n }} title={`${b.label}: ${b.n} (${Math.round((b.n / total) * 100)}%)`} />)}
          </div>
          <ul className="cc-legend">
            {m.buckets.map((b) => <li key={b.key}><span className={`cc-dot cc-k-${b.key}`} />{b.label} <strong>{b.n}</strong></li>)}
          </ul>
        </div>
      )}

      <div className="cc-lane" aria-label="Model lane">
        <span className="cc-lane-title">Model lane</span>
        <div className={`cc-lane-step ${hasModel ? "cc-on" : "cc-off"}`}>
          <span className="cc-lane-k">Model</span>
          <span className="cc-lane-v">{hasModel ? state.config.model || "No model name" : "Not set up"}</span>
        </div>
        <div className={`cc-lane-step ${state.config.hasKey ? "cc-on" : "cc-off"}`}>
          <span className="cc-lane-k">Key</span>
          <span className="cc-lane-v">{state.config.hasKey ? `Saved ${state.config.keyHint}` : state.config.provider === "openai-compatible" ? "Not needed" : "Missing"}</span>
        </div>
        <div className={`cc-lane-step ${state.proposals.length ? "cc-alert" : "cc-on"}`}>
          <span className="cc-lane-k">Suggestions</span>
          <span className="cc-lane-v">{state.proposals.length ? `${state.proposals.length} waiting for you` : "None waiting"}</span>
        </div>
        <div className="cc-lane-step cc-lane-wide">
          <span className="cc-lane-k">Last reply</span>
          <span className="cc-lane-v cc-clip">{lastReply || "No conversation yet"}</span>
        </div>
        <button type="button" className="cc-ghost cc-small" onClick={() => onGo("chat")}><Icon name="chat" /> Open chat</button>
      </div>

      <div className="cc-surface">
        <div className="cc-surface-col">
          <h2>Switches</h2>
          <Switch label="Automation" hint={state.paused ? "Paused. Nothing runs on its own." : "Running: finds, scores and tailors on schedule."} checked={!state.paused} disabled={busy} onChange={(on) => void run(on ? "resume" : "pause")} />
          <Switch
            label="Submit automatically"
            hint={settings.autoSubmit ? "On. Complete forms with no CAPTCHA are sent without you." : "Off. You press Submit on every application."}
            checked={settings.autoSubmit}
            onChange={(on) => (on ? setConfirmSubmit(true) : void onQuick("autoSubmit", false))}
          />
          {confirmSubmit && (
            <div className="cc-banner" role="alertdialog" aria-label="Turn on automatic submit">
              <span>Applications will be sent without you looking at them first. Turn it on?</span>
              <span className="cc-proposal-actions">
                <button type="button" className="cc-small" onClick={() => { setConfirmSubmit(false); void onQuick("autoSubmit", true) }}>Turn on</button>
                <button type="button" className="cc-ghost cc-small" onClick={() => setConfirmSubmit(false)}>Keep it off</button>
              </span>
            </div>
          )}
          <Switch label="United States only" checked={settings.usOnly} onChange={(on) => void onQuick("usOnly", on)} />
          <div className="cc-field">
            <span className="cc-label">Work modes</span>
            <div className="cc-segmented" role="group" aria-label="Work modes">
              {(["remote", "hybrid", "onsite"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={settings.workModes.includes(mode)} onClick={() => void onQuick("workModes", settings.workModes.includes(mode) ? settings.workModes.filter((x) => x !== mode) : [...settings.workModes, mode])}>{mode}</button>
              ))}
            </div>
            <span className="cc-hint">None picked means any.</span>
          </div>
          <div className="cc-field">
            <span className="cc-label">Form browser window</span>
            <div className="cc-segmented" role="group" aria-label="Form browser window">
              {(Object.keys(WINDOW_LABEL) as Settings["applyWindow"][]).map((w) => (
                <button key={w} type="button" aria-pressed={settings.applyWindow === w} onClick={() => void onQuick("applyWindow", w)}>{WINDOW_LABEL[w]}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="cc-surface-col">
          <h2>Levers</h2>
          <Lever label="New postings a day" value={settings.dailyTarget} min={1} max={50} onCommit={(n) => void onQuick("dailyTarget", n)} />
          <Lever label="Ask me first at fit" value={settings.approvalAt} min={0} max={100} onCommit={(n) => void onQuick("approvalAt", n)} />
          <Lever label="Tailor automatically at fit" value={settings.autoTailorAt} min={0} max={100} onCommit={(n) => void onQuick("autoTailorAt", n)} />
          <Lever label="Top match at fit" value={settings.hotScore} min={0} max={100} onCommit={(n) => void onQuick("hotScore", n)} />
          <div className="cc-zones" role="img" aria-label={`Fit under ${ask} is filtered out, ${ask} to ${tailor} asks you first, ${tailor} and up is tailored automatically, ${hot} and up is a top match`}>
            <span className="cc-zone cc-zone-out" style={{ flex: ask }}>{ask >= 14 && "Filtered out"}</span>
            <span className="cc-zone cc-zone-ask" style={{ flex: tailor - ask }}>{tailor - ask >= 12 && "Ask me"}</span>
            <span className="cc-zone cc-zone-auto" style={{ flex: hot - tailor }}>{hot - tailor >= 12 && "Auto"}</span>
            <span className="cc-zone cc-zone-hot" style={{ flex: 100 - hot }}>{100 - hot >= 8 && "Top"}</span>
          </div>
          <span className="cc-hint">What happens to a posting at each fit score, 0 to 100.</span>
        </div>

        <div className="cc-surface-col">
          <h2>Run now</h2>
          <button type="button" disabled={busy || state.paused} onClick={() => void run("discover")}><Icon name="search" /> Find jobs now</button>
          <button type="button" className="cc-ghost" disabled={busy || !state.mail} onClick={() => void run("inbox")}><Icon name="mail" /> Check email now</button>
          {!state.mail && <span className="cc-hint">Email is not connected yet.</span>}
          <button type="button" className="cc-ghost" onClick={() => onGo("apply")}><Icon name="apply" /> {ready} ready to apply{waiting ? `, ${waiting} need your OK` : ""}</button>
          <button type="button" className="cc-ghost" onClick={() => onGo("board")}><Icon name="board" /> Open the switchboard</button>
          <button type="button" className="cc-ghost" onClick={() => onGo("prep")}><Icon name="prep" /> Interview prep ({state.prep.filter((p) => p.live).length} live)</button>
          <button type="button" className="cc-ghost" onClick={() => void onChanged()}><Icon name="refresh" /> Refresh</button>
        </div>
      </div>
    </section>
  )
}
