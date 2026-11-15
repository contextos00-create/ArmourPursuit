# Armour Pursuit

Your whole job search, handled. A command center that finds postings, tailors a resume and cover letter to each one without inventing anything, fills application forms for you to submit, drafts replies for you to send, and helps you prepare for each role.

## What is in this repository

This is the Armour Pursuit feature code, copied out of the Context-TSS monorepo at the same paths:

| Path | What it is |
|---|---|
| `app_build/server/jobhunt/` | The pipeline: search, fit score, tailoring, apply, replies, prep, notifications, command center API. TypeScript, SQLite. |
| `app_build/server/tests/` | Jest tests for the pipeline. |
| `app_build/frontier/src/features/jobhunt/` | The command center screens (React, Tailwind 4, motion). |
| `app_build/frontier/src/routes/command-center.tsx` | The page route. |
| `app_build/frontier/public/` | App icons and the web app manifest. |

## It does not run on its own yet

The screens are mounted inside the Frontier app (TanStack Start) from Context-TSS, which supplies the build, the server functions bridge (`@/lib/contextos-server-bootstrap.server`), fonts and dependencies. The pipeline uses `app_build/server/lib/llm` from the same repo. Those host files are not in this repository. To run it today, use the Context-TSS branch `claude/project-thread-xrpzb0` and follow `app_build/server/jobhunt/README.md` ("First run on your own computer").

One host change is needed for phone access through Tailscale: `allowedHosts: [".ts.net"]` in the Frontier `vite.config.ts` dev server options.

## Ground rules built into the code

- Resume text is never invented. Rewrites must pass a grounding check against the saved resume.
- You press Submit on every application. Auto-submit is off unless you turn it on yourself.
- Nothing is emailed until you press Send on that one draft.
- No LinkedIn automation, no scraping of Glassdoor, LinkedIn or Indeed, no CAPTCHA solving.
- No personal data or keys are in this repository. Resume, settings, API keys and the database live in local files that are not committed.

Full documentation: `app_build/server/jobhunt/README.md`.
