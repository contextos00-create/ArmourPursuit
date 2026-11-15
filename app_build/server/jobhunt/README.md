# Job-hunt pipeline

Route-free Core service: capture a posting, generate a tailored resume and cover
letter from your master resume, track every application's status, text you on
every status change, and watch Gmail for bounce-backs.

Nothing submits an application unless you turn on `autoSubmit` (off by default).

## Setup

1. Save your master resume as JSON Resume (https://jsonresume.org/schema) at
   `app_build/server/data/jobhunt/master-resume.json` (gitignored), or point
   `JOBHUNT_MASTER_RESUME` at it. Put every real bullet you have under
   `work[].highlights`; the tailor only selects, reorders and rephrases them.
2. Add to `app_build/server/.env` (gitignored, never commit):

   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+1...          # or TWILIO_MESSAGING_SERVICE_SID=MG...
   JOBHUNT_SMS_TO=+1...              # your phone
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   GMAIL_REFRESH_TOKEN=...           # scope: https://www.googleapis.com/auth/gmail.readonly
   GMAIL_ADDRESS=you@gmail.com
   ```

   Without Twilio vars, texts are logged as `dry-run`. Without Gmail vars, the
   bounce monitor is off. US numbers need Twilio A2P 10DLC or toll-free
   verification before carriers deliver texts.

## Use (from `app_build/server`)

```
npx ts-node jobhunt/cli.ts add https://boards.greenhouse.io/acme/jobs/123 --email recruiter@acme.com
npx ts-node jobhunt/cli.ts tailor <id>        # writes resume.pdf/.md/.html, cover letter, report.json
npx ts-node jobhunt/cli.ts approve <id>       # tailor a 65-79 or dream-company posting
npx ts-node jobhunt/cli.ts status <id> applied
npx ts-node jobhunt/cli.ts sent <id> "<message-id@mail.gmail.com>" recruiter@acme.com
npx ts-node jobhunt/cli.ts watch 5            # bounce scan every 5 minutes
npx ts-node jobhunt/cli.ts list
```

## Honesty guarantees

- Bullets are only selected and reordered from the master resume.
- LLM rewrites are kept only if every number comes from the original bullet and
  every named tool, employer or skill already appears in the master resume.
  Failing rewrites are discarded and listed in `report.json`.
- Cover letter sentences get the same check; failing sentences are dropped.
- Posting requirements the resume has no evidence for are reported as `gaps`
  and never added.
- Em dashes are stripped from generated text.

## Bounce handling

Gmail is searched for mailer-daemon / undeliverable messages. Standard DSNs
(RFC 3464) and plain-text daemon bounces are parsed; only permanent failures
count. A bounce is matched to an application by the original Message-ID
(recorded with `sent`), then by recipient address (`--email`). The application
moves to `bounced`, which texts you. Unmatched bounces are texted too.

## Fit score and routing

`add` scores each posting 0-100 (skills 40, role and seniority 30, domain 20,
logistics and pay 10) and texts the result. 80+ is tailored automatically,
65-79 or a dream company waits for `approve`, under 65 is filtered out. Hard
filters (blocked company, no sponsorship, years required more than 2 over
yours, pay below floor, wrong work mode or location) filter immediately.
Optional preferences live in `data/jobhunt/preferences.json`:

```json
{ "targetTitles": ["QA Engineer"], "workModes": ["remote", "hybrid"], "locations": ["Cincinnati"],
  "salaryFloor": 80000, "domains": ["healthcare"], "dreamCompanies": [], "blockedCompanies": [] }
```

## PDF gates

The resume is printed to a Letter PDF with headless Chromium (puppeteer, already
a Core dependency). If it runs over the page budget (1 by default), the
lowest-relevance bullet is dropped and it re-renders, never removing a role's
last bullet. The PDF text layer is then checked for standard section headers in
order, the name and every employer, and no ligature glyphs. Results are in
`report.json` under `resume.pdf`.

## Tracking dashboard

`data/jobhunt/dashboard.html` is one self-contained page (no network calls). The scheduler rewrites it after every job that runs; `cli.ts dashboard` writes it on demand.

- **Stats:** tracked, applied, active, response rate, reached interview, offers.
- **How far applications got:** a funnel from tailored to accepted. Assessment counts only when one happened.
- **Per application:** fit score, current status, the furthest stage reached (kept after a rejection), the result, links to the posting and the tailored resume PDF, resume, cover letter and fit report, and a dated timeline with the reason for each change.
- **Hiring manager:** a person who emails about an application (not a no-reply or ATS address) is saved with their name, address and signature title. Add one by hand with `cli.ts contact <app-id> --name "Jane Doe" --title "QA Manager" --linkedin <url>`. Without a profile URL the link is a LinkedIn people search for that name at the company. Every row also has a "find the hiring manager" search. Nothing scrapes LinkedIn.

## Assisted apply

`cli.ts apply <code>` opens the posting's form in a visible Chrome window on your computer, fills it, and stops before Submit. You review and click Submit; the run waits (default 30 min, `--wait`) for the confirmation page and marks the application applied.

- **Filled automatically:** name, email, phone, location, LinkedIn, current company and title (short fields only), the tailored resume PDF, and `cover-letter.txt`.
- **Never guessed:** every other question, including work authorization, sponsorship, demographics, salary and legal acknowledgements, comes only from the answer bank (`data/jobhunt/answers.json`, env `JOBHUNT_ANSWERS`). Anything missing is texted as a numbered list; reply `ANSWER code 2 No` (or `cli.ts answer`) and it is saved for every future form.
- **Works with** Greenhouse (including its searchable dropdowns), Lever and Ashby forms, by reading labels rather than site-specific selectors. Checked read-only against live forms on each.
- **Stops:** a visible CAPTCHA is left to you. Caps: the daily target (default 10) per day, 2 per company per 30 days, and a site pauses after 3 failed runs in a row (`apply-reset <site>` clears it).
- **Auto-submit:** `"autoSubmit": true` in preferences.json submits only when every required field is filled and there is no CAPTCHA. It is off by default; leave it off until the answer bank is complete.

## Follow-through and insights

- **Prep pack:** when an application reaches screening or interviewing, `prep.html` and `prep.md` are written next to its resume. Each posting requirement is matched to your own verbatim bullets; requirements with no proof are listed so you can prepare an honest answer.
- **Referrals:** export LinkedIn connections (LinkedIn, Settings, Data privacy, Get a copy of your data, Connections) and save `Connections.csv` as `data/jobhunt/connections.csv` (env `JOBHUNT_CONNECTIONS`). New postings at a company where you know someone get a referral contact, a `referral-ask.txt` draft, and a line in the text.
- **Outreach, follow-up, thank-you:** drafted, never sent. With the Gmail `gmail.compose` scope they land in Gmail drafts; otherwise they are saved as text files and you get a text. Outreach is drafted once when you apply and a contact exists; a follow-up after 7 days with no reply; a thank-you after an interview.
- **Interviews:** an interview email with a calendar invite or one clear time adds a Google Calendar event (scope `calendar.events`) with a 60-minute reminder, plus a text 1 hour before. Several offered times are left for you to pick.
- **Insights on the dashboard:** skills most asked for that your resume lacks, posted pay by level and work mode, and callback rates by source, fit, title and mode. After 30 sends the ranking learns from what got callbacks (small, capped boost).
- **Top matches:** postings scoring 85+ (`hotScore`) are texted as TOP MATCH and can go over the daily target by up to `hotExtra` per day.

Gmail scopes for everything: `gmail.readonly gmail.compose calendar.events`. Drafts are created in the connected inbox; if your job address only forwards into it, add that address under Gmail Settings, Accounts, "Send mail as" so replies come from it.

## Command center

Open `/command-center` in the Frontier app. Views: Dashboard, Board, Apply, Resume, Prep, Replies, LinkedIn, Controls, and a chat with a model of your choice using your own API key.

### First run on your own computer

1. Get the branch: `git fetch origin claude/project-thread-xrpzb0` then `git checkout claude/project-thread-xrpzb0`.
2. Install (Node 24): `pnpm --dir app_build/frontier install --frozen-lockfile` and `npm --prefix app_build/server ci`.
3. Optional, for texts and email: put the Twilio and Gmail lines from Setup above in `app_build/server/.env`. Without them the app still runs; updates show in the bell only.
4. Start it: `npm run dev` from the repo root, then open `http://127.0.0.1:5196/command-center`.
5. The setup form opens by itself. Type the resume in, or upload a JSON Resume file (it writes `app_build/server/data/jobhunt/master-resume.json`, which is gitignored), fill in the profile, finish.
6. First thing to try: Apply, paste a posting address, then open Resume and Prep for that posting.

### Views added after the first version

- **Setup form:** shown until a resume and profile exist. Resume text is stored as typed.
- **Notifications (bell and Controls):** per-category switches, texting on or off, quiet hours with held messages, a test button, and a feed of everything sent, held or muted.
- **Replies:** rules write a draft for outreach, confirmations, assessments, interview invites, rejections, thank-yous and follow-ups. Every draft waits in a queue. Nothing is emailed until you press Send on that one draft. Drafts with `[bracket notes]` cannot be sent until the note is filled in.
- **Resume:** a per-posting builder. Turn lines on or off, reword them (new numbers or tools not in your resume are flagged), pin lines, pick the summary and skills, see keyword coverage, and ask the agent for wording. Agent rewrites pass the same grounding check. Company research reads the posting, the company's public job board feed and pages you name. It refuses Glassdoor, LinkedIn, Indeed and similar sites; paste your own notes instead.
- **Prep (game plan), one per role:**
  - *Role brief.* Likely interview steps, how demanding the role looks, pay, and how fast replies come. Each item shows its source: the posting, your tracker, postings you track, your own applications, or "typical for this kind of role". Anything not from the posting or your own data is labeled an estimate. Nothing is looked up about the company's real interview process.
  - *Key dates.* Add a phone screen, interview or assessment with reminders (1 week down to 15 minutes before) and a morning line on the days before. Times read from an invite email show up on their own. A thank-you draft is queued after a screen or interview ends.
  - *Plan of attack.* Tasks by phase (start here, build up, day before, day of, afterward), with minutes and the reason for each. Gap study is trimmed to about 90 minutes a day before the date.
  - *Skill builder.* One card per skill the posting names that the resume does not show: the posting's own line, a related skill you do have, study steps with links to official documentation, a readiness rating, and an honest answer that only mentions study steps you ticked. 24 study guides are built in; other skills get general steps. Gaps are never added to the resume.
  - *Coach.* A self-check of eight common worries that works without a model, and a chat with the connected model. Each worry marked "worried" adds matching practice to the top of the plan, and the chat can add concerns and practice items. The model is told not to invent facts about the company and that it is a coach, not a therapist. Its notes are labeled as model-written.
  - *Practice.* Proof lines from your resume per requirement, question lists, optional model-written questions for the posting (labeled as guesses), and your notes.

- **Controls:** every setting in one place, saved to `preferences.json`: titles, title filters, level, pay floor, work modes, places, US only, sponsorship, dream and blocked companies, the company watchlist, job board searches, daily number and fit thresholds, apply caps, the wait for Submit, whether the browser window shows, auto-submit, the search and email schedule, the daily summary time, standing instructions for the agent, the answer bank, and phone access. Input is validated and clamped on the server.
- **Apply:** the list of applications with one-tap Approve, Skip, Fill the form, status changes, and answers to open form questions. Paste a posting address to add it.
- **Live form:** Fill the form opens the posting in a browser on the computer, fills it, and shows a live picture. Click or tap the picture to click the form, type into the selected field, pick dropdown options, scroll, and press Submit application (asks once more first). A CAPTCHA is shown for you to solve yourself; nothing solves or bypasses it. The run ends when the confirmation page is seen, the wait runs out, or you press Stop. One run at a time.
- **Chat:** each message includes a snapshot of the pipeline. The model suggests changes as cards; nothing changes until you click Apply. It can also suggest starting a form, which you then watch and submit. It cannot turn on auto-submit and is told never to answer work authorization, sponsorship, demographic or pay questions for you.
- **Model:** Anthropic (default `claude-opus-5-5`), OpenAI, or any OpenAI-compatible base URL (OpenRouter, a local Ollama). The key is saved in `data/jobhunt/agent.json` (mode 600) and is never sent back to the page.
- **Documents:** links in the dashboard open the generated files; only files inside the documents folder can be read.

### Working well with any model (`brain.ts`)

No model is trained or fine-tuned. A model you connect has never seen this app, so the app does four things around every call:

- **Briefing.** A short text goes in front of every request: first name, headline, latest role, resume skills, what the search is for, the house rules (resume is the only source of facts, no invented company facts, plain words, exact output shape) and your standing instructions. No email or phone. Controls, Agent shows the exact text.
- **Worked examples.** The prompts for rewording, interview questions, the coach and chat proposals each carry one example of the right output.
- **Reading and repair.** JSON answers are read tolerantly (code fences, text around it, trailing commas). If an answer still cannot be read, the app asks once more with the error. Chat and coach blocks get the same single retry. After that the app says the model could not do it, and the parts that work without a model keep working.
- **Model check.** Controls, Agent, "Check this model" runs 5 short probes on fictional sample data and grades them in code: output format, sticking to the facts, proposing changes correctly, respecting the limits, coaching notes. It costs 5 to 10 small model calls. The result is saved per model. A low score is advice; the grounding check and the action whitelist still apply either way.

Wording you typed yourself in the Resume workshop and Replies is passed along as voice samples, so drafts sound like you.

Not checked here: the briefing, examples and the check against a real model. Tests and browser runs used a stand-in model.

### Install as an app

The command center is an installable web app (a PWA): its own icon and window on iPhone, Android, Windows and Mac, no app store.

- **iPhone or iPad (Safari):** Share, Add to Home Screen.
- **Android (Chrome):** menu, Install app (or Add to Home screen).
- **Windows or Mac (Chrome or Edge):** the install icon in the address bar, or Controls, Install as an app.

Limits, plainly: it is the same page in an app window, and it still talks to the computer running the pipeline, which must be on. There is no offline mode. Browsers only offer install over `https` or on `localhost`, so on a phone use the Tailscale address below. Not checked here: an actual install on any real device. Store apps (App Store, Google Play) and a packaged Windows program are not built.

Colors: two neutrals (ink and paper) plus one accent (vermilion) for the single most important action or number on a screen. Green, amber and red appear only for good, warning and problem states.

### On a phone

The page works at phone width. The pipeline itself (browser, database, files) stays on the computer, which must be on.

1. On the computer: Controls, Phone access, set a passcode (8+ characters). Only its salted hash is stored (`data/jobhunt/remote.json`).
2. Make the computer reachable from the phone. Recommended: install Tailscale on both and run `tailscale serve --bg 5196` on the computer, then open `https://<computer>.<tailnet>.ts.net/command-center` on the phone. This is encrypted and limited to your own devices. Not checked in CI or here: the Tailscale step itself.
3. Enter the passcode once per device (30-day session, 5 wrong tries locks for 15 minutes).

From a phone you cannot change the model, its key, or phone access. Do not expose the dev server to a shared network (`--host 0.0.0.0`): that serves the whole Frontier app, unencrypted, to everyone on it.

Environment: `JOBHUNT_DATA_DIR` and `JOBHUNT_DB` move the data folder and database; `JOBHUNT_BROWSER_ARGS` adds Chrome flags for the live form.
