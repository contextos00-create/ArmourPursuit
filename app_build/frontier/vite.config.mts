import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  server: {
    // Lets a private Tailscale address reach the app from a phone.
    allowedHosts: [".ts.net"],
  },
  plugins: [tanstackStart(), tailwindcss(), viteReact()],
})
