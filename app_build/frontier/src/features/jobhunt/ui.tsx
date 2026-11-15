import { useEffect, useState } from "react"

/** Small shared controls for the command center: switches, sliders, rings, sparklines, icons. */

export function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="cc-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="cc-switch-track" aria-hidden="true"><span className="cc-switch-thumb" /></span>
      <span className="cc-switch-text">
        <span className="cc-label">{label}</span>
        {hint && <span className="cc-hint">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * A slider with its number beside it. `onChange` fires while dragging;
 * `onCommit` fires once the person lets go, for controls that save right away.
 */
export function Lever({ label, hint, value, min, max, step, unit, onChange, onCommit }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; unit?: string; onChange?: (n: number) => void; onCommit?: (n: number) => void }) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const clamp = (n: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
  const update = (n: number) => {
    setLocal(n)
    onChange?.(n)
  }
  const commit = () => {
    const n = clamp(local)
    if (n !== local) update(n)
    if (n !== value) onCommit?.(n)
  }
  const share = max > min ? ((clamp(local) - min) / (max - min)) * 100 : 0
  return (
    <label className="cc-lever">
      <span className="cc-lever-head">
        <span className="cc-label">{label}</span>
        <span className="cc-lever-value">
          <input type="number" inputMode="numeric" aria-label={`${label}, exact value`} value={local} min={min} max={max} step={step ?? 1} onChange={(e) => update(Number(e.target.value))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit() }} />
          {unit && <span className="cc-hint cc-inline">{unit}</span>}
        </span>
      </span>
      <input type="range" aria-label={label} value={clamp(local)} min={min} max={max} step={step ?? 1} style={{ "--cc-fill": `${share}%` } as React.CSSProperties} onChange={(e) => update(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      {hint && <span className="cc-hint">{hint}</span>}
    </label>
  )
}

export function Ring({ share, size = 44, label }: { share: number; size?: number; label?: string }) {
  const r = 20
  const c = 2 * Math.PI * r
  const on = Math.max(0, Math.min(1, share)) * c
  return (
    <svg className="cc-ring" width={size} height={size} viewBox="0 0 48 48" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="24" cy="24" r={r} className="cc-ring-bg" />
      <circle cx="24" cy="24" r={r} className="cc-ring-on" strokeDasharray={`${on.toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 24 24)" />
    </svg>
  )
}

export function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const w = 96
  const h = 28
  const step = w / Math.max(1, values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`).join(" ")
  return (
    <svg className="cc-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="cc-spark-area" points={`0,${h} ${pts} ${w},${h}`} />
      <polyline className="cc-spark-line" points={pts} />
    </svg>
  )
}

const ICONS = {
  dashboard: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z",
  board: "M4 5h4v14H4V5zm6 0h4v9h-4V5zm6 0h4v12h-4V5z",
  apply: "M5 4h10l4 4v12H5V4zm9 0v5h5M8 13h8M8 17h5",
  prep: "M12 3l9 5-9 5-9-5 9-5zm-6 8v5c0 1.5 3 3 6 3s6-1.5 6-3v-5",
  network: "M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 19c0-3 3-5 6-5s6 2 6 5m2-5c3 0 6 2 6 5",
  controls: "M4 7h10m4 0h2M4 12h4m4 0h8M4 17h12M16 5v4M10 10v4M18 15v4",
  chat: "M4 5h16v11H9l-5 4V5z",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  play: "M7 5l12 7-12 7V5z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  search: "M11 4a7 7 0 105 12l4 4M11 4a7 7 0 010 14",
  refresh: "M20 5v5h-5M4 19v-5h5M19 10a7 7 0 00-13-2M5 14a7 7 0 0013 2",
  mail: "M4 6h16v12H4V6zm0 1l8 6 8-6",
  resume: "M6 3h9l4 4v14H6V3zm8 0v5h5M9 12h7M9 15.5h7M9 19h4",
  target: "M12 21a9 9 0 100-18 9 9 0 000 18zm0-4a5 5 0 100-10 5 5 0 000 10zm0-4a1 1 0 100-2 1 1 0 000 2z",
  link: "M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1",
} as const

export type IconName = keyof typeof ICONS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="cc-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

/** Open a document returned by the server in a new browser tab. */
export function openDocument(doc: { base64: string; mime: string }) {
  const bytes = Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: doc.mime }))
  window.open(url, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const STATUS_LABEL: Record<string, string> = {
  saved: "Saved", tailored: "Tailored", applied: "Applied", acknowledged: "Received", assessment: "Assessment", screening: "Screening",
  interviewing: "Interviewing", offer: "Offer", accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn", ghosted: "No response", bounced: "Email bounced",
}
