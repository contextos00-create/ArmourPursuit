import "@tanstack/react-start/server-only"
import { getCookie, getRequestHeader, getRequestIP, setCookie } from "@tanstack/react-start/server"
import { serverRequire } from "../../lib/server-require.server"
import type * as CommandCenter from "../../../../server/jobhunt/command-center"

const COOKIE = "jh_session"
const core = () => serverRequire("jobhunt/command-center.ts") as typeof CommandCenter

/**
 * "Local" means the request was made on the computer itself: a localhost
 * address, a loopback connection, and no proxy in between. Anything else
 * (a phone on the home network, or through a private tunnel) is remote.
 */
export function isLocalRequest(): boolean {
  const host = (getRequestHeader("host") || "").replace(/:\d+$/, "")
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return false
  if (getRequestHeader("x-forwarded-for") || getRequestHeader("x-forwarded-host") || getRequestHeader("forwarded")) return false
  const ip = getRequestIP()
  return !ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
}

export function accessState() {
  if (getRequestHeader("sec-fetch-site") === "cross-site") throw new Error("Cross-site requests are not allowed.")
  const local = isLocalRequest()
  const remoteEnabled = core().remoteStatus().enabled
  return { local, remoteEnabled, authed: local || (remoteEnabled && core().remoteValid(getCookie(COOKIE))) }
}

/**
 * The command center reads and changes one person's job search and holds
 * their model key. It answers the computer itself, plus the person's own
 * devices once they have entered the passcode set on the computer.
 */
export function commandCenter(opts: { localOnly?: boolean } = {}): typeof CommandCenter {
  const access = accessState()
  if (opts.localOnly && !access.local) throw new Error("This can only be changed on the computer itself.")
  if (!access.authed) throw new Error("Locked. Enter the passcode.")
  return core()
}

/** Check the passcode from a remote device and start its session. */
export function unlock(passcode: string) {
  if (getRequestHeader("sec-fetch-site") === "cross-site") throw new Error("Cross-site requests are not allowed.")
  const { token, maxAgeSeconds } = core().remoteLogin(passcode, (getRequestHeader("user-agent") || "").slice(0, 80))
  setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: maxAgeSeconds,
    secure: getRequestHeader("x-forwarded-proto") === "https",
  })
  return { ok: true }
}
