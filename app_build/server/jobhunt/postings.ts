'use strict';

/**
 * Fetch a single posting from a public ATS job board by URL, using each
 * vendor's documented public JSON endpoint (no scraping, no login):
 *   Greenhouse  https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}
 *   Lever       https://api.lever.co/v0/postings/{company}/{id}
 *   Ashby       https://api.ashbyhq.com/posting-api/job-board/{org}
 * Anything else: paste the description text and use source "manual".
 */

import { htmlToText } from './text';
import type { NewJobPosting } from './types';

export type ParsedPostingUrl =
  | { source: 'greenhouse'; board: string; id: string }
  | { source: 'lever'; company: string; id: string }
  | { source: 'ashby'; org: string; id: string };

export function parsePostingUrl(input: string): ParsedPostingUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const ghId = url.searchParams.get('gh_jid');
    const jobsIdx = segs.indexOf('jobs');
    if (jobsIdx > 0 && segs[jobsIdx + 1]) return { source: 'greenhouse', board: segs[jobsIdx - 1], id: segs[jobsIdx + 1] };
    if (ghId && segs[0]) return { source: 'greenhouse', board: segs[0], id: ghId };
  }
  if (host === 'jobs.lever.co' && segs.length >= 2) return { source: 'lever', company: segs[0], id: segs[1] };
  if (host === 'jobs.ashbyhq.com' && segs.length >= 2) return { source: 'ashby', org: segs[0], id: segs[1] };
  return null;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

function titleCase(slug: string) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchPosting(input: string, fetchImpl: typeof fetch = fetch): Promise<NewJobPosting> {
  const parsed = parsePostingUrl(input);
  if (!parsed) throw new Error('Unsupported job URL. Supported: Greenhouse, Lever, Ashby. Paste the description manually for other sites.');

  if (parsed.source === 'greenhouse') {
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parsed.board)}`;
    const job = await getJson(fetchImpl, `${base}/jobs/${encodeURIComponent(parsed.id)}`);
    let company = titleCase(parsed.board);
    try {
      company = (await getJson(fetchImpl, base)).name || company;
    } catch {
      /* board metadata is optional */
    }
    return {
      source: 'greenhouse', sourceId: `${parsed.board}:${job.id}`, url: job.absolute_url ?? input, company,
      title: job.title, location: job.location?.name ?? null, descriptionText: htmlToText(job.content ?? ''),
    };
  }

  if (parsed.source === 'lever') {
    const job = await getJson(fetchImpl, `https://api.lever.co/v0/postings/${encodeURIComponent(parsed.company)}/${encodeURIComponent(parsed.id)}`);
    const lists = (job.lists ?? []).map((l: any) => `${l.text}:\n${htmlToText(l.content ?? '')}`).join('\n\n');
    const description = [job.descriptionPlain ?? htmlToText(job.description ?? ''), lists, job.additionalPlain ?? ''].filter(Boolean).join('\n\n');
    return {
      source: 'lever', sourceId: `${parsed.company}:${job.id}`, url: job.hostedUrl ?? input, company: titleCase(parsed.company),
      title: job.text, location: job.categories?.location ?? null, descriptionText: description,
    };
  }

  const board = await getJson(fetchImpl, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parsed.org)}`);
  const job = (board.jobs ?? []).find((j: any) => j.id === parsed.id || String(j.jobUrl ?? '').includes(parsed.id));
  if (!job) throw new Error(`Ashby posting ${parsed.id} not found on board ${parsed.org} (it may be closed).`);
  return {
    source: 'ashby', sourceId: `${parsed.org}:${job.id}`, url: job.jobUrl ?? input, company: titleCase(parsed.org),
    title: job.title, location: job.location ?? null, descriptionText: job.descriptionPlain || htmlToText(job.descriptionHtml ?? ''),
  };
}
