import "@tanstack/react-start/server-only"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Loads the pipeline code in `app_build/server` inside this same process.
 * There is no second server and no network hop: the page's server functions
 * call the pipeline directly. The pipeline is plain TypeScript, so `tsx` is
 * registered once to let Node load it.
 */

let serverRoot = ""
let load: ReturnType<typeof createRequire> | undefined

function findServerRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    for (const candidate of [join(dir, "app_build", "server"), join(dir, "server")]) {
      if (existsSync(join(candidate, "jobhunt", "command-center.ts"))) return candidate
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error("Could not find app_build/server. Start the app from the Armour Pursuit folder with: npm start")
}

function bootstrap() {
  if (load) return
  const major = Number(process.versions.node.split(".", 1)[0])
  if (major < 22) throw new Error(`Armour Pursuit needs Node 22.13 or newer. This is Node ${process.versions.node}.`)
  serverRoot = findServerRoot()
  const req = createRequire(pathToFileURL(join(serverRoot, "index.js")))
  ;(req("dotenv") as { config: (o: { path: string; override: boolean }) => unknown }).config({ path: join(serverRoot, ".env"), override: false })
  ;(req("tsx/cjs/api") as { register: () => unknown }).register()
  load = req
}

/** Require a module by its path inside `app_build/server`, for example `jobhunt/command-center.ts`. */
export function serverRequire(path: string): unknown {
  bootstrap()
  return load!(join(serverRoot, path))
}
