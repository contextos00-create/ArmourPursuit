'use strict';

/**
 * Command line for the job-hunt pipeline. From app_build/server:
 *
 *   npx ts-node jobhunt/cli.ts add <posting-url> [--email recruiter@co.com]
 *   npx ts-node jobhunt/cli.ts add-manual --company "Acme" --title "Engineer" --file posting.txt [--url ...] [--email ...]
 *   npx ts-node jobhunt/cli.ts tailor <app-id> [--force x]   (auto-runs on add when fit >= 80)
 *   npx ts-node jobhunt/cli.ts approve <app-id>               (tailor a 65-79 or dream-company posting)
 *   npx ts-node jobhunt/cli.ts status <app-id> <status> [reason...]
 *   npx ts-node jobhunt/cli.ts sent <app-id> <message-id> [to-address]
 *   npx ts-node jobhunt/cli.ts list [status]
 *   npx ts-node jobhunt/cli.ts history <app-id>
 *   npx ts-node jobhunt/cli.ts bounces           (scan the mailbox once)
 *   npx ts-node jobhunt/cli.ts watch [minutes]   (keep scanning, default 5)
 *   npx ts-node jobhunt/cli.ts run              (everything on a schedule; this is the one to leave running)
 *   npx ts-node jobhunt/cli.ts discover         (one discovery pass now)
 *   npx ts-node jobhunt/cli.ts inbox            (classify recent employer email once)
 *   npx ts-node jobhunt/cli.ts digest | sweep
 *   npx ts-node jobhunt/cli.ts reply "YES abcd" (test a text command locally)
 *   npx ts-node jobhunt/cli.ts apply <app-id> [--wait 30]   (fill the form in a visible browser, you click Submit)
 *   npx ts-node jobhunt/cli.ts answer <app-id> <n> <answer...>  (answer question n from the last apply run)
 *   npx ts-node jobhunt/cli.ts answers                 (list the saved answer bank)
 *   npx ts-node jobhunt/cli.ts apply-reset <greenhouse|lever|ashby|other>
 *   npx ts-node jobhunt/cli.ts dashboard        (write data/jobhunt/dashboard.html)
 *   npx ts-node jobhunt/cli.ts contact <app-id> --name "Jane Doe" [--title ...] [--email ...] [--linkedin URL]
 *   npx ts-node jobhunt/cli.ts sms-test
 *
 * App ids can be shortened to their first 8 characters.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJobHunt, APPLICATION_STATUSES, type ApplicationStatus } from './index';
import { createTwilioSender, smsConfigFromEnv } from './sms';

// eslint-disable-next-line @typescript-eslint/no-require-imports
try { require('dotenv').config({ path: join(__dirname, '..', '.env'), override: false }); } catch { /* dotenv optional */ }

function flags(args: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[++i] ?? '';
    else rest.push(args[i]);
  }
  return { flags: out, rest };
}

function printAdded(r: any) {
  console.log(`Saved ${r.job.company}, ${r.job.title} as ${r.application.id.slice(0, 8)}`);
  if (r.fit) {
    console.log(`Fit ${r.fit.score}/100 -> ${r.fit.route}`);
    for (const line of r.fit.rationale) console.log(`  ${line}`);
  }
  for (const file of r.tailored?.files ?? []) console.log(`  ${file}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags: f, rest } = flags(args);
  if (cmd === 'sms-test') {
    const config = smsConfigFromEnv();
    const r = await createTwilioSender(config).send('[Job] Test text from your job-hunt pipeline.');
    console.log(config ? r : 'Twilio env vars missing, nothing sent (dry run).');
    return;
  }
  const jh = createJobHunt();
  const resolve = (prefix: string) => {
    const match = jh.list().filter((a) => a.id.startsWith(prefix));
    if (match.length !== 1) throw new Error(match.length ? `Ambiguous id ${prefix}` : `No application ${prefix}`);
    return match[0].id;
  };
  try {
    switch (cmd) {
      case 'add': {
        const r = await jh.addPosting({ url: rest[0] }, { contactEmail: f.email ?? null });
        printAdded(r);
        break;
      }
      case 'add-manual': {
        if (!f.company || !f.title || !f.file) throw new Error('add-manual needs --company, --title and --file');
        const r = await jh.addPosting(
          { source: 'manual', company: f.company, title: f.title, url: f.url ?? null, location: f.location ?? null, descriptionText: readFileSync(f.file, 'utf8') },
          { contactEmail: f.email ?? null },
        );
        printAdded(r);
        break;
      }
      case 'approve':
      case 'tailor': {
        const r = cmd === 'approve' ? await jh.approve(resolve(rest[0])) : await jh.tailor(resolve(rest[0]), { force: 'force' in f });
        const report: any = r.resume.report;
        console.log(`Fit ${report.fitScore}%. Matched: ${report.matchedKeywords.join(', ') || 'none'}`);
        if (report.gaps.length) console.log(`Gaps (not on your resume, left out): ${report.gaps.join(', ')}`);
        if (report.rejectedRewrites.length) console.log(`Discarded ${report.rejectedRewrites.length} LLM rewrite(s) that added facts.`);
        for (const file of r.files) console.log(`  ${file}`);
        break;
      }
      case 'status': {
        const status = rest[1] as ApplicationStatus;
        if (!APPLICATION_STATUSES.includes(status)) throw new Error(`Status must be one of: ${APPLICATION_STATUSES.join(', ')}`);
        const change = await jh.setStatus(resolve(rest[0]), status, rest.slice(2).join(' ') || undefined);
        console.log(`${change.job.company}: ${change.event.fromStatus} to ${change.event.toStatus}`);
        break;
      }
      case 'sent':
        jh.recordSentEmail(resolve(rest[0]), rest[1], rest[2]);
        console.log('Recorded.');
        break;
      case 'list':
        for (const a of jh.list(rest[0] as ApplicationStatus | undefined)) {
          console.log(`${a.id.slice(0, 8)}  ${a.status.padEnd(12)} ${a.job.company}, ${a.job.title}${a.contactEmail ? `  <${a.contactEmail}>` : ''}`);
        }
        break;
      case 'history':
        for (const e of jh.history(resolve(rest[0]))) {
          console.log(`${new Date(e.createdAt).toISOString()}  ${e.fromStatus ?? '-'} to ${e.toStatus}  [${e.source}] ${e.reason ?? ''}`);
        }
        break;
      case 'bounces':
        console.log(await jh.scanBounces());
        break;
      case 'discover': {
        const r = await jh.discover();
        console.log(`${r.fetched} fetched, ${r.titleMatched} title matches, ${r.fresh} new, ${r.added.length} added, ${r.deferred} deferred to tomorrow, ${r.filteredOut} filtered out`);
        for (const e of r.errors) console.log(`  error: ${e}`);
        break;
      }
      case 'inbox':
        console.log(await jh.scanInbox());
        break;
      case 'digest':
        console.log(await jh.sendDigest());
        break;
      case 'sweep':
        console.log(`${(await jh.sweepStale()).length} marked ghosted`);
        break;
      case 'apply': {
        const id = resolve(rest[0] ?? '');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        const minutes = Number(f.wait ?? 30);
        console.log(`Filling the form. Review it in the browser and click Submit. Waiting up to ${minutes} min for the confirmation page.`);
        const r = await jh.applyWith(page, id, { waitForSubmitMs: minutes * 60_000 });
        console.log(`Filled ${r.filled} fields.${r.captcha ? ' CAPTCHA on page.' : ''}`);
        r.unanswered.forEach((u, i) => console.log(`  ${i + 1}) ${u.label}${u.required ? ' (required)' : ''}`));
        console.log(r.confirmed ? 'Confirmation seen, marked applied.' : 'No confirmation seen. If you submitted, run: status <id> applied');
        if (r.screenshot) console.log(`Screenshot: ${r.screenshot}`);
        await browser.close();
        break;
      }
      case 'answer': {
        const id = resolve(rest[0] ?? '');
        const q = jh.answerQuestion(id, Number(rest[1]), rest.slice(2).join(' '));
        console.log(`Saved answer for: ${q}`);
        break;
      }
      case 'answers':
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        for (const a of require('./apply').loadBank(jh.answersPath)) console.log(`${a.question}\n  -> ${a.answer}`);
        break;
      case 'apply-reset':
        jh.store.setKv(`apply_fail_${rest[0] ?? 'other'}`, '0');
        console.log(`Cleared failures for ${rest[0] ?? 'other'}.`);
        break;
      case 'dashboard':
        console.log(jh.writeDashboard(rest[0]));
        break;
      case 'contact': {
        const id = resolve(rest[0] ?? '');
        if (!f.name && !f.email && !f.linkedin) throw new Error('Give at least --name, --email or --linkedin.');
        jh.addContact(id, { name: f.name || null, title: f.title || null, email: f.email || null, linkedinUrl: f.linkedin || null });
        console.log(`Saved contact for ${id.slice(0, 8)}. ${jh.writeDashboard()}`);
        break;
      }
      case 'reply':
        console.log(await jh.handleReply(rest.join(' ')));
        break;
      case 'run': {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./scheduler').startScheduler(jh);
        console.log('Running: replies every minute, inbox and bounces every 5 min, discovery every 3 h (7 AM to 9 PM), digest 6:30 PM. Ctrl+C to stop.');
        return;
      }
      case 'watch': {
        const minutes = Number(rest[0] || 5);
        jh.startBounceMonitor(minutes * 60_000);
        console.log(`Watching for bounces every ${minutes} min. Ctrl+C to stop.`);
        setInterval(() => {}, 1 << 30);
        return;
      }
      default:
        console.log(readFileSync(__filename, 'utf8').split('*/')[0]);
    }
  } finally {
    if (cmd !== 'watch' && cmd !== 'run') jh.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
