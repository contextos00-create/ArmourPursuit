'use strict';

/**
 * Referral matcher. Reads the Connections.csv file from LinkedIn's own data
 * export (Settings, Data privacy, Get a copy of your data, Connections) and
 * finds people who work at a posting's company. Nothing is scraped. The file
 * stays local (data/jobhunt/connections.csv, env JOBHUNT_CONNECTIONS).
 */

import { existsSync, readFileSync } from 'node:fs';
import { normalizeTerm } from './text';
import type { JobPosting, MasterResume } from './types';

export interface Connection {
  firstName: string;
  lastName: string;
  url: string | null;
  email: string | null;
  company: string;
  position: string;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** LinkedIn's export starts with a few "Notes" lines before the header row. */
export function parseConnections(csv: string): Connection[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /first name/i.test(l) && /company/i.test(l));
  if (headerAt < 0) return [];
  const header = parseCsvLine(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const out: Connection[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue;
    const c = parseCsvLine(line);
    const get = (name: string) => (col(name) >= 0 ? c[col(name)] ?? '' : '');
    if (!get('company')) continue;
    out.push({
      firstName: get('first name'), lastName: get('last name'), url: get('url') || null,
      email: get('email address') || null, company: get('company'), position: get('position'),
    });
  }
  return out;
}

export function loadConnections(path: string): Connection[] {
  return existsSync(path) ? parseConnections(readFileSync(path, 'utf8')) : [];
}

export function companyKey(name: string): string {
  return normalizeTerm(name).replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|group|holdings|the)\b/g, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** People at the posting's company, those in QA or engineering first. */
export function matchReferrals(connections: Connection[], company: string): Connection[] {
  const key = companyKey(company);
  if (!key) return [];
  const rank = (c: Connection) => (/\b(qa|quality|test|sdet)\b/i.test(c.position) ? 0 : /engineer|developer|manager|recruit|talent/i.test(c.position) ? 1 : 2);
  return connections.filter((c) => {
    const k = companyKey(c.company);
    return k === key || (k.length > 3 && (k.startsWith(`${key} `) || key.startsWith(`${k} `)));
  }).sort((a, b) => rank(a) - rank(b));
}

/** A short ask, written from the posting and the candidate's name only. Edit before sending. */
export function referralAsk(person: Connection, job: JobPosting, master: MasterResume): string {
  const first = master.basics.name.split(/\s+/)[0];
  return [
    `Hi ${person.firstName},`,
    '',
    `I hope you're doing well. I saw that ${job.company} is hiring a ${job.title}${job.url ? ` (${job.url})` : ''}, and it lines up closely with my QA background.`,
    `Would you be open to referring me, or pointing me to the right person on the team? I'm happy to send my resume and a short note you can forward.`,
    '',
    `Thanks either way,`,
    first,
  ].join('\n');
}
