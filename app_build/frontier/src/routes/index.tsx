import { createFileRoute, redirect } from "@tanstack/react-router"

// The app has one page. The bare address goes straight to it.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/command-center" })
  },
})
