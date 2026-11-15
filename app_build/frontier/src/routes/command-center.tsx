import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"

const CommandCenter = lazy(() => import("@/features/jobhunt/CommandCenter"))

export const Route = createFileRoute("/command-center")({
  // Makes the page installable as an app on phones and desktops (see the web manifest).
  head: () => ({
    meta: [
      { title: "Armour Pursuit" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#161513", media: "(prefers-color-scheme: dark)" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Pursuit" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    ],
    links: [
      { rel: "manifest", href: "/armour-pursuit.webmanifest" },
      { rel: "apple-touch-icon", href: "/armour-pursuit-apple-180.png" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/armour-pursuit-icon-32.png" },
    ],
  }),
  component: () => (
    <Suspense fallback={<p style={{ padding: 16 }}>Opening the command center…</p>}>
      <CommandCenter />
    </Suspense>
  ),
})
