import { useEffect, useRef, useState } from "react"
import type { CommandCenterState } from "./CommandCenter"
import { getNotifications, sendTestNotification } from "./jobhunt.functions"
import { Lever, Switch } from "./ui"

type Settings = CommandCenterState["settings"]
type Feed = CommandCenterState["notify"]["feed"]

const hour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`
const STATUS: Record<string, string> = { sent: "Texted", "dry-run": "App only", app: "App only", held: "Held for quiet hours", failed: "Text failed" }
const SEEN_KEY = "jh-feed-seen"

function canPopUp() {
  return typeof window !== "undefined" && "Notification" in window
}

/** What he gets and when. Used in the setup form and under Controls. */
export function NotifySettings({ state, s, set, onNotice }: { state: CommandCenterState; s: Settings; set: <TKey extends keyof Settings>(key: TKey, value: Settings[TKey]) => void; onNotice: (m: string) => void }) {
  const [testing, setTesting] = useState(false)
  const off = !s.notifyEnabled

  async function browser(on: boolean) {
    if (on && canPopUp() && Notification.permission !== "granted") {
      const answer = await Notification.requestPermission()
      if (answer !== "granted") {
        onNotice("This browser blocked notifications. Allow them for this page in the browser's site settings, then turn this on again.")
        return
      }
    }
    set("notifyBrowser", on)
  }

  return (
    <div className="cc-notify">
      <Switch label="Notifications" hint={off ? "Off. Nothing is texted or popped up. Updates still show on the dashboard." : "On."} checked={s.notifyEnabled} onChange={(b) => set("notifyEnabled", b)} />

      <fieldset className="cc-field" disabled={off}>
        <legend className="cc-label">How</legend>
        <Switch
          label="Text my phone"
          hint={state.notify.smsReady ? "Texting is connected." : "Texting is not connected on the computer yet (Twilio settings in the .env file). Until then, updates land in the app only."}
          checked={s.notifySms}
          onChange={(b) => set("notifySms", b)}
        />
        <Switch
          label="Pop up in this browser"
          hint={canPopUp() ? "Shows while this page is open. Each browser and phone asks for its own permission." : "This browser does not support pop-up notifications."}
          checked={s.notifyBrowser}
          disabled={!canPopUp()}
          onChange={(b) => void browser(b)}
        />
      </fieldset>

      <fieldset className="cc-field" disabled={off}>
        <legend className="cc-label">What</legend>
        <div className="cc-kinds">
          {state.notify.categories.map((c) => (
            <Switch key={c.key} label={c.label} checked={!s.notifyOff.includes(c.key)} onChange={(on) => set("notifyOff", on ? s.notifyOff.filter((k) => k !== c.key) : [...s.notifyOff, c.key])} />
          ))}
        </div>
        <span className="cc-hint">Answers to something you text the app always come back.</span>
      </fieldset>

      <fieldset className="cc-field" disabled={off}>
        <legend className="cc-label">When</legend>
        <Switch label="Quiet hours" hint={s.quietEnabled ? `No texts from ${hour(s.quietStart)} to ${hour(s.quietEnd)}. They are held and sent when quiet hours end, three at most plus a count.` : "Off. Texts arrive as things happen."} checked={s.quietEnabled} onChange={(b) => set("quietEnabled", b)} />
        {s.quietEnabled && (
          <>
            <div className="cc-row">
              <Lever label="Quiet from" unit={hour(s.quietStart)} value={s.quietStart} min={0} max={23} onChange={(n) => set("quietStart", n)} />
              <Lever label="Quiet until" unit={hour(s.quietEnd)} value={s.quietEnd} min={0} max={23} onChange={(n) => set("quietEnd", n)} />
            </div>
            <Switch label="Let urgent ones through" hint="Top matches and interview reminders still text during quiet hours." checked={s.quietUrgent} onChange={(b) => set("quietUrgent", b)} />
          </>
        )}
        <div className="cc-row">
          <Lever label="Daily summary, hour" unit={hour(s.digestHour)} value={s.digestHour} min={0} max={23} onChange={(n) => set("digestHour", n)} />
          <Lever label="Daily summary, minute" value={s.digestMinute} min={0} max={59} step={5} onChange={(n) => set("digestMinute", n)} />
        </div>
      </fieldset>

      <div className="cc-addrow">
        <button
          type="button"
          className="cc-ghost"
          disabled={testing}
          onClick={async () => {
            setTesting(true)
            try {
              onNotice((await sendTestNotification()).message)
            } catch (e) {
              onNotice((e as Error).message)
            } finally {
              setTesting(false)
            }
          }}
        >
          Send a test
        </button>
        <span className="cc-hint">Save your changes first. The test uses what is saved.</span>
      </div>
    </div>
  )
}

/** Header bell: the notification list, an unread count, and browser pop-ups for new items. */
export function Bell({ state }: { state: CommandCenterState }) {
  const [feed, setFeed] = useState<Feed>(state.notify.feed)
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(0)
  const popped = useRef<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const browserOn = state.settings.notifyEnabled && state.settings.notifyBrowser

  useEffect(() => setFeed(state.notify.feed), [state.notify.feed])
  useEffect(() => {
    try {
      setSeen(Number(localStorage.getItem(SEEN_KEY)) || 0)
    } catch {
      /* unread count just starts from zero */
    }
  }, [])

  // Check for new items while the page is open.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setFeed((await getNotifications()).feed)
      } catch {
        /* next tick retries */
      }
    }, 45_000)
    return () => clearInterval(timer)
  }, [])

  // Pop up anything newer than what this page has already shown.
  useEffect(() => {
    const newest = feed[0]?.id ?? 0
    if (popped.current === null) {
      popped.current = newest
      return
    }
    if (browserOn && canPopUp() && Notification.permission === "granted") {
      for (const item of feed.filter((f) => f.id > (popped.current ?? 0)).slice(0, 3).reverse()) new Notification("Armour Pursuit", { body: item.body, tag: `jh-${item.id}` })
    }
    popped.current = Math.max(popped.current, newest)
  }, [feed, browserOn])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", close)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", close)
    }
  }, [open])

  const unread = feed.filter((f) => f.id > seen).length
  function toggle() {
    setOpen((o) => !o)
    const newest = feed[0]?.id ?? 0
    if (newest > seen) {
      setSeen(newest)
      try {
        localStorage.setItem(SEEN_KEY, String(newest))
      } catch {
        /* not remembered */
      }
    }
  }

  return (
    <div className="cc-bell" ref={wrap}>
      <button type="button" className="cc-ghost" aria-expanded={open} aria-label={unread ? `Notifications, ${unread} new` : "Notifications"} onClick={toggle}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zm4 5h4" /></svg>
        {unread > 0 && <span className="cc-count cc-count-hot">{unread}</span>}
      </button>
      {open && (
        <div className="cc-feed" role="dialog" aria-label="Notifications">
          <h2>Notifications{state.notify.held ? `, ${state.notify.held} held for quiet hours` : ""}</h2>
          {feed.length === 0 && <p className="cc-hint">Nothing yet. New matches, status changes and reminders show up here.</p>}
          <ul>
            {feed.map((f) => (
              <li key={f.id}>
                <span>{f.body}</span>
                <span className="cc-hint">{new Date(f.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {STATUS[f.status] ?? f.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
