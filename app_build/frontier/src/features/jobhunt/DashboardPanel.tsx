import { useEffect, useId, useMemo, useRef, useState } from "react"
import { animate, motion, useInView, useReducedMotion } from "motion/react"
import { area as d3area, curveMonotoneX, line as d3line } from "d3"
import { readJobDocument } from "./jobhunt.functions"
import { Icon, openDocument } from "./ui"
import type { ReactNode } from "react"
import type { CommandCenterState, Tab } from "./CommandCenter"

/**
 * The dashboard. Every chart here is drawn from the pipeline's own records:
 * nothing is sample data and nothing is decoration.
 *
 * Color: the interface is white and green. Charts add three more hues (blue,
 * orange, yellow) where series need telling apart; the order and steps were
 * checked for color-blind separation, and every series also has a text label.
 */

type Data = CommandCenterState["dashboard"]
type Row = Data["rows"][number]

const EASE = [0.22, 1, 0.36, 1] as const
const SERIES = {
  found: { label: "Found", color: "var(--viz-blue)" },
  applied: { label: "Applied", color: "var(--viz-green)" },
  replies: { label: "Replies", color: "var(--viz-orange)" },
} as const
type SeriesKey = keyof typeof SERIES
const BUCKET_COLOR: Record<string, string> = { queued: "var(--viz-blue)", waiting: "var(--viz-yellow)", talking: "var(--viz-green)", closed: "var(--viz-gray)" }

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const money = (n: number) => `$${Math.round(n / 1000)}k`

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** A number that counts up once when it first scrolls into view. */
function CountUp({ value, suffix = "" }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true })
  const still = useReducedMotion()
  const [shown, setShown] = useState(still ? value : 0)
  useEffect(() => {
    if (!seen || still) {
      if (still) setShown(value)
      return
    }
    const controls = animate(0, value, { duration: 0.9, ease: EASE, onUpdate: (v) => setShown(Math.round(v)) })
    return () => controls.stop()
  }, [seen, value, still])
  return <span ref={ref}>{shown}{suffix}</span>
}

function Card({ children, className = "", delay = 0, label }: { children: ReactNode; className?: string; delay?: number; label?: string }) {
  const still = useReducedMotion()
  return (
    <motion.section
      aria-label={label}
      initial={still ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: EASE, delay }}
      className={`relative min-w-0 rounded-[20px] border border-(--cc-line) bg-(--cc-card) p-5 sm:p-6 transition-shadow duration-300 hover:shadow-[0_24px_48px_-32px_rgba(13,20,17,.35)] ${className}`}
    >
      {children}
    </motion.section>
  )
}

function CardHead({ title, note, right }: { title: string; note?: string; right?: ReactNode }) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[16px] leading-tight font-semibold tracking-[-0.015em] text-(--cc-fg)">{title}</h3>
        {note && <p className="mt-1 text-[13px] leading-snug text-(--cc-muted)">{note}</p>}
      </div>
      {right}
    </header>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-(--cc-line) px-4 py-8 text-center text-[13px] text-(--cc-muted)">{children}</p>
}

type Tip = { x: number; y: number; body: ReactNode } | null
function TipBox({ tip }: { tip: Tip }) {
  if (!tip) return null
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-[120px] -translate-x-1/2 -translate-y-full rounded-xl bg-(--ap-tip) px-3 py-2 text-[12.5px] leading-snug text-(--ap-tip-fg) shadow-[0_12px_28px_-12px_rgba(0,0,0,.5)]"
      style={{ left: tip.x, top: tip.y - 10 }}
    >
      {tip.body}
    </div>
  )
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
}

// ── Hero: today's number ─────────────────────────────────────────────────────

function Hero({ data }: { data: Data }) {
  const still = useReducedMotion()
  const m = data.metrics
  const target = data.target
  const share = target ? Math.min(1, m.foundToday / target) : 1
  const r = 78
  const c = 2 * Math.PI * r
  const left = target ? Math.max(0, target - m.foundToday) : 0
  return (
    <motion.section
      aria-label="Today"
      initial={still ? false : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: EASE }}
      className="ap-hero relative isolate flex min-h-[300px] flex-col justify-between overflow-hidden rounded-[24px] p-6 text-white sm:p-7"
    >
      <div aria-hidden="true" className="ap-hero-glow" />
      <div aria-hidden="true" className="ap-hero-grid" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11.5px] font-semibold tracking-[0.14em] text-white/75 uppercase">{target ? "Found today" : "Tracked"}</p>
          <p className="mt-3 flex items-baseline gap-2 font-semibold tracking-[-0.05em]">
            <span className="text-[76px] leading-[0.9] sm:text-[88px]"><CountUp value={target ? m.foundToday : m.tracked} /></span>
            {target && <span className="text-[26px] tracking-[-0.02em] text-white/70">of {target}</span>}
          </p>
          <p className="mt-4 max-w-[26ch] text-[15px] leading-snug text-white/85">
            {target ? (left === 0 ? "Daily number reached. Anything more today is a bonus." : `${left} more to hit today's number. The search keeps running on its schedule.`) : "Postings in the pipeline."}
          </p>
        </div>
        <svg viewBox="0 0 180 180" className="size-[132px] shrink-0 sm:size-[168px]" role="img" aria-label={target ? `${m.foundToday} of ${target} found today` : `${m.tracked} tracked`}>
          <circle cx="90" cy="90" r={r} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="12" />
          <motion.circle
            cx="90" cy="90" r={r} fill="none" stroke="#fff" strokeWidth="12" strokeLinecap="round" transform="rotate(-90 90 90)"
            strokeDasharray={c}
            initial={{ strokeDashoffset: still ? c * (1 - share) : c }}
            animate={{ strokeDashoffset: c * (1 - share) }}
            transition={{ duration: 1.3, ease: EASE, delay: 0.2 }}
          />
          <text x="90" y="86" textAnchor="middle" className="fill-white text-[34px] font-semibold tracking-[-0.04em]">{Math.round(share * 100)}%</text>
          <text x="90" y="108" textAnchor="middle" className="fill-white/70 text-[11px] font-medium tracking-[0.1em] uppercase">of today</text>
        </svg>
      </div>
      <dl className="mt-6 grid grid-cols-3 gap-3 border-t border-white/20 pt-5">
        {[
          ["This week", String(m.sentThisWeek)],
          ["Heard back", `${m.responseRate}%`],
          ["In play", String(m.active)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] font-medium tracking-[0.08em] text-white/70 uppercase">{k}</dt>
            <dd className="mt-1 text-[24px] leading-none font-semibold tracking-[-0.03em]">{v}</dd>
          </div>
        ))}
      </dl>
    </motion.section>
  )
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

function MiniSpark({ values, color }: { values: number[]; color: string }) {
  const id = useId()
  const still = useReducedMotion()
  const w = 96
  const h = 36
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - 4 - (v / max) * (h - 8)] as [number, number])
  const path = d3line().curve(curveMonotoneX)(pts) ?? ""
  const fill = d3area().curve(curveMonotoneX).y0(h)(pts) ?? ""
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-24 shrink-0 overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient>
      </defs>
      <path d={fill} fill={`url(#${id})`} />
      <motion.path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" initial={{ pathLength: still ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: EASE, delay: 0.3 }} />
      <circle cx={pts.at(-1)?.[0]} cy={pts.at(-1)?.[1]} r="3" fill={color} stroke="var(--cc-card)" strokeWidth="2" />
    </svg>
  )
}

function MiniRing({ share, color }: { share: number; color: string }) {
  const still = useReducedMotion()
  const r = 15
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 40 40" className="size-10 shrink-0" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--cc-track)" strokeWidth="5" />
      <motion.circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" transform="rotate(-90 20 20)" strokeDasharray={c} initial={{ strokeDashoffset: still ? c * (1 - share) : c }} animate={{ strokeDashoffset: c * (1 - share) }} transition={{ duration: 1.1, ease: EASE, delay: 0.3 }} />
    </svg>
  )
}

function Kpi({ label, value, suffix, sub, visual, delay, night }: { label: string; value: number; suffix?: string; sub: string; visual?: ReactNode; delay: number; night?: boolean }) {
  return (
    <Card delay={delay} className={`flex min-h-[142px] flex-col justify-between !p-5 ${night ? "ap-night" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="ap-night-k text-[11.5px] font-semibold tracking-[0.1em] text-(--cc-muted) uppercase">{label}</p>
        {visual}
      </div>
      <div>
        <p className="ap-night-v text-[40px] leading-none font-semibold tracking-[-0.045em] text-(--cc-fg) tabular-nums"><CountUp value={value} suffix={suffix} /></p>
        <p className="ap-night-sub mt-2 text-[13px] leading-snug text-(--cc-muted)">{sub}</p>
      </div>
    </Card>
  )
}

// ── Activity: found, applied, replies per week ──────────────────────────────

function ActivityChart({ weeks }: { weeks: Data["weeks"] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const still = useReducedMotion()
  const gid = useId()
  const [hover, setHover] = useState<number | null>(null)
  const [off, setOff] = useState<Partial<Record<SeriesKey, boolean>>>({})
  const keys = (Object.keys(SERIES) as SeriesKey[]).filter((k) => !off[k])
  const h = 260
  const pad = { l: 30, r: 16, t: 14, b: 30 }
  const w = Math.max(280, width)
  const max = Math.max(2, ...weeks.flatMap((wk) => keys.map((k) => wk[k])))
  const top = Math.ceil(max / 2) * 2
  const x = (i: number) => pad.l + (i / Math.max(1, weeks.length - 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v / top) * (h - pad.t - pad.b)
  const ticks = [0, top / 2, top]
  const any = weeks.some((wk) => wk.found + wk.applied + wk.replies > 0)
  const totals = (k: SeriesKey) => weeks.reduce((sum, wk) => sum + wk[k], 0)

  const legend = (
    <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-label="Show or hide a line">
      {(Object.keys(SERIES) as SeriesKey[]).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={!off[k]}
          onClick={() => setOff((o) => ({ ...o, [k]: !o[k] }))}
          className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--cc-ink) ${off[k] ? "border-(--cc-line) text-(--cc-muted) opacity-60" : "border-(--cc-line) bg-(--cc-card) text-(--cc-fg) hover:bg-(--cc-track)"}`}
        >
          <Swatch color={SERIES[k].color} />{SERIES[k].label}<span className="text-(--cc-muted) tabular-nums">{totals(k)}</span>
        </button>
      ))}
    </div>
  )

  return (
    <Card delay={0.12} className="lg:col-span-8" label="Activity by week">
      <CardHead title="Momentum" note="Postings found, applications sent and first replies, per week" right={legend} />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {!any ? <Empty>Nothing in the last 8 weeks yet. This fills in as the search runs.</Empty> : (
          <>
            <svg width={w} height={h} className="block max-w-full" role="img" aria-label={`Weekly activity for the last ${weeks.length} weeks. ${keys.map((k) => `${SERIES[k].label} ${totals(k)}`).join(", ")}.`}>
              <defs>
                {keys.map((k) => (
                  <linearGradient key={k} id={`${gid}-${k}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={SERIES[k].color} stopOpacity=".22" /><stop offset="1" stopColor={SERIES[k].color} stopOpacity="0" /></linearGradient>
                ))}
              </defs>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--cc-line)" strokeDasharray={t === 0 ? undefined : "3 5"} />
                  <text x={pad.l - 10} y={y(t) + 4} textAnchor="end" className="fill-(--cc-muted) text-[11px] tabular-nums">{t}</text>
                </g>
              ))}
              {weeks.map((wk, i) => (w < 520 && (weeks.length - 1 - i) % 2 === 1) ? null : (
                <text key={wk.start} x={x(i)} y={h - 8} textAnchor={i === 0 ? "start" : i === weeks.length - 1 ? "end" : "middle"} className={`text-[11px] ${i === weeks.length - 1 ? "fill-(--cc-fg) font-semibold" : "fill-(--cc-muted)"}`}>{i === weeks.length - 1 ? "This week" : shortDate(wk.start)}</text>
              ))}
              {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke="var(--cc-fg)" strokeOpacity=".25" />}
              {keys.map((k, n) => {
                const pts = weeks.map((wk, i) => [x(i), y(wk[k])] as [number, number])
                return (
                  <g key={k}>
                    <motion.path d={d3area().curve(curveMonotoneX).y0(y(0))(pts) ?? ""} fill={`url(#${gid}-${k})`} initial={{ opacity: still ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.5 + n * 0.12 }} />
                    <motion.path d={d3line().curve(curveMonotoneX)(pts) ?? ""} fill="none" stroke={SERIES[k].color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: still ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: EASE, delay: 0.25 + n * 0.12 }} />
                    {pts.map(([px, py], i) => (hover === i || i === pts.length - 1) && <circle key={i} cx={px} cy={py} r={hover === i ? 5 : 4} fill={SERIES[k].color} stroke="var(--cc-card)" strokeWidth="2" />)}
                  </g>
                )
              })}
              {weeks.map((wk, i) => (
                <rect key={wk.start} x={x(i) - (w - pad.l - pad.r) / weeks.length / 2} y={0} width={(w - pad.l - pad.r) / weeks.length} height={h} fill="transparent" tabIndex={0} aria-label={`Week of ${shortDate(wk.start)}: ${keys.map((k) => `${SERIES[k].label} ${wk[k]}`).join(", ")}`} className="outline-none" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              ))}
            </svg>
            {hover != null && (
              <TipBox tip={{
                x: Math.min(w - 80, Math.max(80, x(hover))),
                y: Math.min(...keys.map((k) => y(weeks[hover][k])), h - pad.b),
                body: (
                  <>
                    <p className="mb-1 font-semibold">Week of {shortDate(weeks[hover].start)}</p>
                    {keys.map((k) => <p key={k} className="flex items-center gap-2"><Swatch color={SERIES[k].color} /><span className="opacity-80">{SERIES[k].label}</span><span className="ml-auto pl-3 font-semibold tabular-nums">{weeks[hover][k]}</span></p>)}
                  </>
                ),
              }} />
            )}
          </>
        )}
      </div>
    </Card>
  )
}

// ── Where things stand: donut ────────────────────────────────────────────────

function StandDonut({ buckets, total }: { buckets: Data["metrics"]["buckets"]; total: number }) {
  const still = useReducedMotion()
  const [hover, setHover] = useState<string | null>(null)
  const r = 62
  const c = 2 * Math.PI * r
  const gap = buckets.filter((b) => b.n).length > 1 ? 5 : 0
  let acc = 0
  const arcs = buckets.filter((b) => b.n > 0).map((b) => {
    const len = (b.n / total) * c
    const arc = { ...b, len: Math.max(1, len - gap), start: acc }
    acc += len
    return arc
  })
  const active = buckets.find((b) => b.key === hover)
  return (
    <Card delay={0.18} className="lg:col-span-4" label="Where things stand">
      <CardHead title="Where things stand" note="Every tracked posting by its current state" />
      {total === 0 ? <Empty>No postings tracked yet.</Empty> : (
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <svg viewBox="0 0 160 160" className="size-[176px]" role="img" aria-label={buckets.map((b) => `${b.label} ${b.n}`).join(", ")}>
              <circle cx="80" cy="80" r={r} fill="none" stroke="var(--cc-track)" strokeWidth="16" />
              {arcs.map((a, i) => (
                <motion.circle
                  key={a.key} cx="80" cy="80" r={r} fill="none" stroke={BUCKET_COLOR[a.key]} strokeLinecap="butt"
                  strokeWidth={hover === a.key ? 20 : 16}
                  strokeDasharray={`${a.len} ${c - a.len}`} strokeDashoffset={-a.start} transform="rotate(-90 80 80)"
                  initial={{ opacity: still ? 1 : 0 }} animate={{ opacity: hover && hover !== a.key ? 0.35 : 1 }} transition={{ duration: 0.35, delay: hover ? 0 : 0.3 + i * 0.1 }}
                  onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover(null)}
                  style={{ transition: "stroke-width .2s" }}
                />
              ))}
            </svg>
            <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
              <p className="text-[38px] leading-none font-semibold tracking-[-0.045em] text-(--cc-fg) tabular-nums">{active ? active.n : total}</p>
              <p className="mt-1 text-[11px] font-semibold tracking-[0.1em] text-(--cc-muted) uppercase">{active ? active.label : "Tracked"}</p>
            </div>
          </div>
          <ul className="grid w-full grid-cols-2 gap-x-5 gap-y-2.5">
            {buckets.map((b) => (
              <li key={b.key} className="flex items-center gap-2 text-[13.5px] text-(--cc-fg)" onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)}>
                <Swatch color={BUCKET_COLOR[b.key]} />
                <span className="truncate">{b.label}</span>
                <span className="ml-auto font-semibold tabular-nums">{b.n}</span>
                <span className="w-9 text-right text-[12px] text-(--cc-muted) tabular-nums">{pct(b.n, total)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

// ── Funnel ───────────────────────────────────────────────────────────────────

function Funnel({ funnel, tracked }: { funnel: Data["funnel"]; tracked: number }) {
  const still = useReducedMotion()
  const max = Math.max(1, ...funnel.map((f) => f.n))
  // Assessment is optional, so it is shown but not used as the base for the next step's rate.
  const steps = funnel.map((f, i) => {
    const prev = funnel.slice(0, i).reverse().find((p) => p.stage !== "assessment")
    return { ...f, from: f.stage === "assessment" || !prev ? null : pct(f.n, prev.n) }
  })
  return (
    <Card delay={0.22} className="lg:col-span-5" label="How far applications got">
      <CardHead title="How far applications got" note="Postings that reached each stage, and the share that moved on" />
      {tracked === 0 ? <Empty>No postings tracked yet.</Empty> : (
        <ol className="grid gap-2">
          {steps.map((f, i) => (
            <li key={f.stage} className="group grid grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-3">
              <span className="truncate text-[13.5px] text-(--cc-fg)">{f.label}</span>
              <span className="flex h-8 justify-center rounded-lg bg-(--cc-track)">
                <motion.span
                  className="flex h-full items-center justify-center rounded-lg text-[12.5px] font-semibold tabular-nums"
                  style={{ background: `var(--ramp-${Math.min(7, i + 1)})`, color: i + 1 >= 4 ? "var(--ramp-on-deep)" : "var(--ramp-on-pale)", minWidth: f.n ? 30 : 4 }}
                  initial={{ width: still ? `${(f.n / max) * 100}%` : "0%" }}
                  animate={{ width: `${(f.n / max) * 100}%` }}
                  transition={{ duration: 0.9, ease: EASE, delay: 0.3 + i * 0.06 }}
                >
                  {f.n > 0 && f.n}
                </motion.span>
              </span>
              <span className="text-right text-[12.5px] text-(--cc-muted) tabular-nums">{f.from == null ? (f.stage === "assessment" ? "optional" : "") : `${f.from}% on`}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

// ── Heatmap: activity by day ─────────────────────────────────────────────────

function Heatmap({ days }: { days: Data["days"] }) {
  const [tip, setTip] = useState<Tip>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const still = useReducedMotion()
  const max = Math.max(1, ...days.map((d) => d.n))
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)))
  // Columns are weeks (Monday first); pad the first column so days line up by weekday.
  const lead = (new Date(days[0].day).getDay() + 6) % 7
  const cells: ({ day: number; n: number } | null)[] = [...Array.from({ length: lead }, () => null), ...days]
  const cols = Math.ceil(cells.length / 7)
  const total = days.reduce((s, d) => s + d.n, 0)
  const busiest = days.reduce((a, b) => (b.n > a.n ? b : a), days[0])
  const activeDays = days.filter((d) => d.n > 0).length
  return (
    <Card delay={0.26} className="lg:col-span-7" label="Activity by day">
      <CardHead
        title="Every day counts"
        note={`${total} pipeline updates on ${activeDays} of the last ${days.length} days${busiest.n ? `. Busiest: ${shortDate(busiest.day)}` : ""}`}
        right={(
          <div className="flex shrink-0 items-center gap-1 text-[11.5px] text-(--cc-muted)" aria-hidden="true">
            Less{[0, 1, 2, 3, 4].map((l) => <span key={l} className="size-3 rounded-[4px]" style={{ background: `var(--heat-${l})` }} />)}More
          </div>
        )}
      />
      <div ref={boxRef} className="relative" onMouseLeave={() => setTip(null)}>
        <div className="grid grid-flow-col grid-rows-7 gap-[3px] sm:gap-[5px]" style={{ gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))` }} role="img" aria-label={`Activity for the last ${days.length} days: ${total} updates on ${activeDays} days.`}>
          {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((d, i) => <span key={i} className="self-center pr-2 text-[11px] leading-none text-(--cc-muted)">{d}</span>)}
          {cells.map((cell, i) => cell == null ? <span key={i} /> : (
            <motion.span
              key={cell.day}
              className="aspect-square min-h-2.5 w-full rounded-[4px] sm:rounded-[6px] outline-offset-1 hover:outline-2 hover:outline-(--cc-fg)"
              style={{ background: `var(--heat-${level(cell.n)})` }}
              initial={still ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35, delay: 0.3 + Math.floor(i / 7) * 0.03 }}
              onMouseEnter={(e) => {
                const box = boxRef.current?.getBoundingClientRect()
                const at = e.currentTarget.getBoundingClientRect()
                if (box) setTip({ x: at.left - box.left + at.width / 2, y: at.top - box.top, body: <><span className="font-semibold">{cell.n} update{cell.n === 1 ? "" : "s"}</span><span className="opacity-75"> · {new Date(cell.day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span></> })
              }}
            />
          ))}
        </div>
        <TipBox tip={tip} />
      </div>
    </Card>
  )
}

// ── Fit histogram ────────────────────────────────────────────────────────────

function FitChart({ bands }: { bands: Data["bands"] }) {
  const still = useReducedMotion()
  const max = Math.max(1, ...bands.map((b) => b.n))
  const total = bands.reduce((s, b) => s + b.n, 0)
  const strong = bands.slice(3).reduce((s, b) => s + b.n, 0)
  return (
    <Card delay={0.3} className="lg:col-span-4" label="Fit scores">
      <CardHead title="Fit scores" note={total ? `${strong} of ${total} scored postings are an 80 or better` : "How well tracked postings match the resume"} />
      {total === 0 ? <Empty>No scored postings yet.</Empty> : (
        <div className="grid h-[188px] grid-cols-5 items-end gap-3" role="img" aria-label={bands.map((b) => `${b.label}: ${b.n}`).join(", ")}>
          {bands.map((b, i) => (
            <div key={b.label} className="group flex h-full flex-col items-center justify-end gap-1.5">
              <span className="text-[13px] font-semibold text-(--cc-fg) tabular-nums">{b.n}</span>
              <motion.span
                className="w-full max-w-14 rounded-t-[10px] rounded-b-[3px] transition-[filter] group-hover:brightness-110"
                style={{ background: i >= 3 ? "var(--viz-green)" : "var(--viz-green-pale)", minHeight: 4 }}
                initial={{ height: still ? `${(b.n / max) * 100}%` : "0%" }} animate={{ height: `${(b.n / max) * 100}%` }} transition={{ duration: 0.9, ease: EASE, delay: 0.35 + i * 0.07 }}
              />
              <span className="text-[11.5px] whitespace-nowrap text-(--cc-muted)">{b.label.replace(" and up", "+").replace(" to ", "–").replace("Under ", "<")}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Ranked bars (skills gap, callbacks) and pay ranges ───────────────────────

function BarList({ rows, color, unit = "%" }: { rows: { label: string; value: number; tip: string }[]; color: string; unit?: string }) {
  const still = useReducedMotion()
  // Values are percentages, so the track is the full 100.
  const max = 100
  return (
    <ul className="grid gap-3">
      {rows.map((r, i) => (
        <li key={r.label} title={r.tip}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13.5px]">
            <span className="truncate text-(--cc-fg)">{r.label}</span>
            <span className="font-semibold text-(--cc-fg) tabular-nums">{r.value}{unit}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-(--cc-track)">
            <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: still ? `${(r.value / max) * 100}%` : "0%" }} animate={{ width: `${(r.value / max) * 100}%` }} transition={{ duration: 0.9, ease: EASE, delay: 0.35 + i * 0.05 }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Insights({ insights }: { insights: NonNullable<Data["insights"]> }) {
  const still = useReducedMotion()
  const gap = insights.gap.rows.slice(0, 6)
  const pay = insights.salary.rows
  const payMax = Math.max(1, ...pay.map((r) => r.medianMax))
  const payMin = Math.min(...pay.map((r) => r.medianMin), payMax) * 0.85
  const pos = (n: number) => ((n - payMin) / (payMax - payMin || 1)) * 100
  return (
    <>
      <Card delay={0.34} className="lg:col-span-4" label="Skills gap">
        <CardHead title="Skills gap" note={gap.length ? `Asked for in the ${insights.gap.total} matched postings, not on the resume` : "Asked for, not on the resume"} />
        {gap.length ? <BarList color="var(--viz-orange)" rows={gap.map((r) => ({ label: r.term, value: r.share, tip: `${r.term}: in ${r.postings} postings, a must-have in ${r.asMust}` }))} /> : <Empty>Not enough postings yet.</Empty>}
      </Card>
      <Card delay={0.38} className="lg:col-span-4" label="Pay in collected postings">
        <CardHead title="Pay on offer" note={pay.length ? `Median posted range. ${insights.salary.withPay} of ${insights.salary.total} postings list pay` : "What the market is offering"} />
        {pay.length ? (
          <ul className="grid gap-4">
            {pay.map((r, i) => (
              <li key={r.group} title={`${r.group}: ${money(r.medianMin)} to ${money(r.medianMax)} across ${r.n} postings`}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13.5px]">
                  <span className="truncate text-(--cc-fg)">{r.group}</span>
                  <span className="font-semibold text-(--cc-fg) tabular-nums">{money(r.medianMin)} to {money(r.medianMax)}</span>
                </div>
                <div className="relative h-2 rounded-full bg-(--cc-track)">
                  <motion.div className="absolute inset-y-0 rounded-full" style={{ background: "var(--viz-blue)", left: `${pos(r.medianMin)}%` }} initial={{ width: still ? `${Math.max(2, pos(r.medianMax) - pos(r.medianMin))}%` : "0%" }} animate={{ width: `${Math.max(2, pos(r.medianMax) - pos(r.medianMin))}%` }} transition={{ duration: 0.9, ease: EASE, delay: 0.4 + i * 0.06 }} />
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty>No postings with a pay range yet.</Empty>}
      </Card>
      <Card delay={0.42} className="lg:col-span-12" label="What is getting callbacks">
        <CardHead title="What's getting callbacks" note={insights.works.sent >= 5 ? `${insights.works.callbacks} callbacks from ${insights.works.sent} sent (${insights.works.rate}%). A group needs about 8 sends before its rate means much` : `${insights.works.sent} sent so far. This fills in after 5 or more`} />
        {insights.works.sent >= 5 && insights.works.rows.length > 0 && (
          <div className="grid gap-x-10 gap-y-3 md:grid-cols-2">
            <BarList color="var(--viz-green)" rows={insights.works.rows.slice(0, Math.ceil(insights.works.rows.length / 2)).map((r) => ({ label: `${r.dimension}: ${r.group}`, value: r.rate, tip: `${r.callbacks} callbacks from ${r.sent} sent` }))} />
            <BarList color="var(--viz-green)" rows={insights.works.rows.slice(Math.ceil(insights.works.rows.length / 2)).map((r) => ({ label: `${r.dimension}: ${r.group}`, value: r.rate, tip: `${r.callbacks} callbacks from ${r.sent} sent` }))} />
          </div>
        )}
      </Card>
    </>
  )
}

// ── Applications list ────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  offer: "bg-(--cc-ink) text-(--cc-accent-fg)", accepted: "bg-(--cc-ink) text-(--cc-accent-fg)",
  interviewing: "bg-(--cc-soft) text-(--cc-ink)", screening: "bg-(--cc-soft) text-(--cc-ink)",
  assessment: "bg-(--cc-warn-bg) text-(--cc-warn)",
  rejected: "bg-(--cc-bad-bg) text-(--cc-bad)", bounced: "bg-(--cc-bad-bg) text-(--cc-bad)",
}

function AppRow({ row, onNotice }: { row: Row; onNotice: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const openDoc = async (href: string) => {
    try {
      openDocument(await readJobDocument({ data: { path: href.replace(/^jh-doc:/, "") } }))
    } catch (e) {
      onNotice((e as Error).message)
    }
  }
  return (
    <li className={`rounded-2xl border bg-(--cc-card) transition-[border-color,box-shadow] duration-200 ${open ? "border-(--cc-ink) shadow-[0_20px_40px_-30px_rgba(13,20,17,.4)]" : "border-(--cc-line) hover:border-[color-mix(in_srgb,var(--cc-ink)_45%,var(--cc-line))]"}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-2xl px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--cc-ink) md:grid-cols-[minmax(0,1fr)_52px_124px_132px_96px]">
        <span className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-content-center rounded-full bg-(--cc-soft) text-[15px] font-semibold text-(--cc-ink)">{(row.company.trim().charAt(0) || "?").toUpperCase()}</span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-(--cc-fg)">{row.company}</span>
            <span className="block truncate text-[13px] text-(--cc-muted)">{row.title}{row.location ? `, ${row.location}` : ""}</span>
          </span>
        </span>
        <span className={`hidden rounded-lg py-1 text-center text-[13px] font-semibold tabular-nums md:block ${row.fit != null && row.fit >= 80 ? "bg-(--cc-soft) text-(--cc-ink)" : "text-(--cc-muted)"}`} title={row.fit == null ? undefined : "Fit score"}>{row.fit ?? ""}</span>
        <span className={`justify-self-start rounded-full px-3 py-1 text-[12px] font-semibold ${TONE[row.status] ?? "bg-(--cc-track) text-(--cc-fg)"}`}>{row.statusLabel}</span>
        <span className="hidden gap-[3px] md:flex" role="img" aria-label={`Furthest stage: ${row.furthestLabel}`}>
          {Array.from({ length: 7 }, (_, i) => <span key={i} className={`h-1.5 w-4 rounded-full ${i + 1 <= row.stageIndex ? "bg-(--cc-ink)" : "bg-(--cc-track)"}`} />)}
        </span>
        <span className="hidden text-right text-[12.5px] text-(--cc-muted) md:block">{shortDate(row.appliedAt ?? row.updatedAt)}</span>
      </button>
      {open && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="grid gap-x-8 gap-y-4 border-t border-(--cc-line) px-5 py-4 text-[13.5px] text-(--cc-fg) md:grid-cols-2 xl:grid-cols-4">
          <Detail title="Result">{row.result}, got as far as <span className="font-semibold">{row.furthestLabel}</span>.{row.url && <> <a className="font-medium text-(--cc-ink) underline-offset-2 hover:underline" href={row.url} target="_blank" rel="noopener noreferrer">Open posting</a></>}</Detail>
          <Detail title="Documents">
            {row.docs.length ? row.docs.map((d) => <button key={d.href} type="button" onClick={() => void openDoc(d.href)} className="mr-3 cursor-pointer font-medium text-(--cc-ink) underline-offset-2 hover:underline">{d.label}</button>) : <span className="text-(--cc-muted)">Not tailored yet</span>}
          </Detail>
          <Detail title="Contacts">
            {row.contacts.length ? row.contacts.map((c, i) => <span key={i} className="block">{c.name ?? c.email}{c.title && <span className="text-(--cc-muted)"> {c.title}</span>} <a className="font-medium text-(--cc-ink) underline-offset-2 hover:underline" href={c.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a></span>) : <span className="text-(--cc-muted)">None yet. </span>}
            <a className="font-medium text-(--cc-ink) underline-offset-2 hover:underline" href={row.hiringSearch} target="_blank" rel="noopener noreferrer">Find the hiring manager</a>
          </Detail>
          <Detail title="Timeline">
            <ol className="grid gap-1">{row.timeline.map((t, i) => <li key={i}><span className="text-(--cc-muted) tabular-nums">{shortDate(t.at)}</span> {t.to}{t.reason && <span className="text-(--cc-muted)"> {t.reason}</span>}</li>)}</ol>
          </Detail>
          {row.gaps.length > 0 && <Detail title="Gaps left off the resume">{row.gaps.join(", ")}</Detail>}
        </motion.div>
      )}
    </li>
  )
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <div className="min-w-0"><h4 className="mb-1 text-[11px] font-semibold tracking-[0.1em] text-(--cc-muted) uppercase">{title}</h4><div className="leading-relaxed">{children}</div></div>
}

function Applications({ rows, onNotice }: { rows: Row[]; onNotice: (text: string) => void }) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("")
  const [more, setMore] = useState(false)
  const statuses = useMemo(() => [...new Map(rows.map((r) => [r.status, r.statusLabel])).entries()], [rows])
  const shown = rows.filter((r) => (!status || r.status === status) && (!q || `${r.company} ${r.title} ${r.statusLabel} ${r.contacts.map((c) => c.name ?? "").join(" ")}`.toLowerCase().includes(q.toLowerCase())))
  const visible = more || q || status ? shown : shown.slice(0, 8)
  const field = "h-11 rounded-xl border border-(--cc-line) bg-(--cc-card) px-4 text-[14px] text-(--cc-fg) outline-none transition-colors placeholder:text-(--cc-muted) hover:border-(--cc-ink) focus-visible:border-(--cc-ink) focus-visible:ring-2 focus-visible:ring-(--cc-glow)"
  return (
    <section aria-label="Applications" className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[24px] leading-tight font-semibold tracking-[-0.03em] text-(--cc-fg)">Applications</h2>
          <p className="mt-1 text-[13.5px] text-(--cc-muted)">{rows.length} tracked. Open a row for documents, contacts and the timeline.</p>
        </div>
        <div className="flex flex-1 flex-wrap justify-end gap-2">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, title, contact" aria-label="Search applications" className={`${field} min-w-[200px] flex-1 md:max-w-[340px]`} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className={`${field} cursor-pointer`}>
            <option value="">All statuses</option>
            {statuses.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
          </select>
        </div>
      </div>
      {rows.length === 0 ? <Empty>No applications yet. Press Find jobs now, or paste a posting under Apply.</Empty> : shown.length === 0 ? <Empty>Nothing matches that search.</Empty> : (
        <ul className="grid gap-2">{visible.map((r) => <AppRow key={r.id} row={r} onNotice={onNotice} />)}</ul>
      )}
      {!more && !q && !status && shown.length > 8 && (
        <div className="mt-4 text-center">
          <button type="button" onClick={() => setMore(true)} className="cursor-pointer rounded-full border border-(--cc-line) bg-(--cc-card) px-5 py-2.5 text-[13.5px] font-semibold text-(--cc-fg) transition-colors outline-none hover:border-(--cc-ink) hover:text-(--cc-ink) focus-visible:ring-2 focus-visible:ring-(--cc-ink)">Show all {shown.length}</button>
        </div>
      )}
    </section>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function DashboardPanel({ state, onGo, onNotice }: { state: CommandCenterState; onGo: (tab: Tab) => void; onNotice: (text: string) => void }) {
  const data = state.dashboard
  const m = data.metrics
  const still = useReducedMotion()
  const ready = state.replies.queue.filter((d) => d.ready).length
  const liveRoles = state.prep.filter((p) => p.live).length
  const toApply = state.applications.filter((a) => a.canApply).length
  const next: { n: number; label: string; tab: Tab }[] = [
    { n: toApply, label: toApply === 1 ? "application ready to send" : "applications ready to send", tab: "apply" },
    { n: ready, label: ready === 1 ? "reply draft waiting for you" : "reply drafts waiting for you", tab: "replies" },
    { n: liveRoles, label: liveRoles === 1 ? "role to prepare for" : "roles to prepare for", tab: "prep" },
  ]
  const hour = new Date(data.now).getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
  return (
    <div className="ap mx-auto w-full max-w-[1320px] pb-16">
      <motion.header initial={still ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="mb-7 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.14em] text-(--cc-ink) uppercase">{new Date(data.now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h2 className="mt-2 text-[34px] leading-[1.05] font-semibold tracking-[-0.04em] text-(--cc-fg) sm:text-[44px]">{greeting}. <span className="text-(--cc-muted)">{m.active} in play, {m.interviews} at interview.</span></h2>
        </div>
      </motion.header>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5"><Hero data={data} /></div>
        <div className="grid grid-cols-2 gap-4 lg:col-span-7 xl:grid-cols-3">
          <Kpi delay={0.04} label="Applied" value={m.applied} sub={`${m.sentThisWeek} sent this week`} visual={<MiniSpark values={m.weeks} color="var(--viz-green)" />} />
          <Kpi delay={0.07} label="Response rate" value={m.responseRate} suffix="%" sub={`${m.responded} of ${m.applied} heard back`} visual={<MiniRing share={m.applied ? m.responded / m.applied : 0} color="var(--viz-orange)" />} />
          <Kpi delay={0.1} label="Interviews" value={m.interviews} sub={`${pct(m.interviews, m.applied)}% of applied`} visual={<MiniRing share={m.applied ? m.interviews / m.applied : 0} color="var(--viz-blue)" />} />
          <Kpi night delay={0.13} label="Offers" value={m.offers} sub={m.offers ? "Offer or accepted" : "None yet. Keep going."} />
          <Kpi delay={0.16} label="In play" value={m.active} sub="Sent and still open" />
          <Kpi delay={0.19} label="Tracked" value={m.tracked} sub="Postings in the pipeline" />
        </div>

        {next.some((x) => x.n > 0) && (
          <motion.nav aria-label="What needs you" initial={still ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE, delay: 0.1 }} className="grid gap-3 sm:grid-cols-3 lg:col-span-12">
            {next.filter((x) => x.n > 0).map((x) => (
              <button key={x.tab} type="button" onClick={() => onGo(x.tab)} className="group flex cursor-pointer items-center gap-3 rounded-2xl border border-(--cc-line) bg-(--cc-soft) px-4 py-3.5 text-left transition-[transform,border-color] duration-200 outline-none hover:-translate-y-0.5 hover:border-(--cc-ink) focus-visible:ring-2 focus-visible:ring-(--cc-ink)">
                <span className="grid size-10 shrink-0 place-content-center rounded-full bg-(--cc-ink) text-[15px] font-semibold text-(--cc-accent-fg) tabular-nums">{x.n}</span>
                <span className="min-w-0 flex-1 text-[14.5px] font-medium text-(--cc-fg)">{x.label}</span>
                <span aria-hidden="true" className="text-[18px] text-(--cc-ink) transition-transform duration-200 group-hover:translate-x-1">→</span>
              </button>
            ))}
          </motion.nav>
        )}

        <ActivityChart weeks={data.weeks} />
        <StandDonut buckets={m.buckets} total={m.tracked} />
        <Funnel funnel={data.funnel} tracked={m.tracked} />
        <Heatmap days={data.days} />
        <FitChart bands={data.bands} />
        {data.insights ? <Insights insights={data.insights} /> : (
          <Card delay={0.34} className="lg:col-span-8" label="Insights"><CardHead title="Skills, pay and callbacks" /><Empty>These fill in once a few postings are collected.</Empty></Card>
        )}
      </div>

      <Applications rows={data.rows} onNotice={onNotice} />
      <p className="mt-10 flex items-center justify-center gap-2 text-[12px] text-(--cc-muted)"><Icon name="refresh" /> Updated {new Date(data.now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Every chart is drawn from this pipeline's own records.</p>
    </div>
  )
}
