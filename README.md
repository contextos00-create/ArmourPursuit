# Armour Pursuit

Your whole job search, handled. A command center that runs on your own computer: it finds postings, scores the fit, tailors a resume and cover letter to each one without inventing anything, fills application forms for you to submit, drafts replies for you to send, and helps you prepare for each role.

Everything stays on your machine. This repository holds only the app. Your resume, settings, keys and database are written to local folders that Git ignores.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer (24 recommended) and Git.

```
git clone https://github.com/contextos00-create/ArmourPursuit.git
cd ArmourPursuit
npm install
npm start
```

Then open **http://127.0.0.1:5196** in your browser. Leave the terminal window open while you use the app. Press Ctrl+C in it to stop.

`npm install` takes a few minutes the first time. It also downloads a copy of Chrome (about 200 MB) that the app uses to make PDFs and fill application forms. If that download was skipped, run `npm run setup:browser`.

## First steps in the app

1. **Setup form.** It opens by itself the first time. Type your resume in or upload a JSON Resume file, fill in the profile, finish. The app only ever uses what you enter here; it does not add experience you do not have.
2. **Connect a model (optional).** Controls, Agent: pick Anthropic, OpenAI or an OpenAI-compatible address and paste your own API key. The key is saved on your computer and never sent back to the page. Without a model the app still finds, scores, tailors (select and reorder only), tracks and drafts from templates. The chat, the coach and reworded lines need a model.
3. **Add a posting.** Apply, paste a job posting address. Then open Resume and Prep for it.
4. **Texts and email (optional).** Copy `app_build/server/.env.example` to `app_build/server/.env` and fill in Twilio and Gmail details. Without them, updates show in the bell inside the app.
5. **Phone and install.** Controls has phone access (a passcode you set on the computer). The app can be installed as an app from the browser menu.

Details for every screen and setting: [`app_build/server/jobhunt/README.md`](app_build/server/jobhunt/README.md).

## Where your data lives

| What | Where | In Git? |
|---|---|---|
| Resume, settings, answers, model key, generated documents | `app_build/server/data/jobhunt/` | No, ignored |
| Database of applications | `app_build/server/data/jobhunt.db` | No, ignored |
| Twilio and Gmail details | `app_build/server/.env` | No, ignored |

To back up or move to another computer, copy `app_build/server/data/` and `app_build/server/.env`.

## Ground rules built into the code

- Resume text is never invented. Rewrites must pass a grounding check against the saved resume.
- You press Submit on every application. Auto-submit is off unless you turn it on yourself.
- Nothing is emailed until you press Send on that one draft.
- No LinkedIn automation, no scraping of Glassdoor, LinkedIn or Indeed, no CAPTCHA solving.
- Estimates are labeled as estimates and show their source.

## For developers

| Command | What it does |
|---|---|
| `npm start` | Runs the app at http://127.0.0.1:5196 |
| `npm test` | Runs the pipeline tests (Jest) |
| `npm run typecheck` | Type-checks the screens and the pipeline |
| `npm run cli -- list` | Command line access to the pipeline |

| Path | What it is |
|---|---|
| `app_build/server/jobhunt/` | The pipeline: search, fit score, tailoring, apply, replies, prep, notifications. TypeScript, SQLite (built into Node). |
| `app_build/server/tests/` | Tests, with a fictional person as the fixture. |
| `app_build/frontier/src/` | The screens (React, TanStack Start, Tailwind 4, motion, d3). |
| `app_build/frontier/public/` | App icons and the web app manifest. |
| `launch/` | Launch video, still and feature deck. |

The app runs through the Vite dev server. There is no separate production build yet.
