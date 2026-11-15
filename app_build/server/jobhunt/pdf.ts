'use strict';

/**
 * PDF output with the spec's layout gates:
 *   1. Page budget: render, count pages, and while over budget drop the
 *      lowest-relevance bullet (never a role's last one) and re-render.
 *   2. ATS text-layer audit: extract the PDF text and confirm standard section
 *      headers are present and in order, and there are no ligature glyphs or
 *      replacement characters that break ATS parsing.
 *
 * Rendering uses headless Chromium via puppeteer and text extraction uses
 * pdf-parse, both already Core dependencies. Both are injectable for tests.
 * (The spec names Typst; Chromium is used because it is already installed
 * with Core and renders the same HTML the user previews.)
 */

import { renderResumeHtml, renderResumeMarkdown, type TailoredResume } from './tailor';
import type { JobPosting, MasterResume } from './types';

export interface PdfTools {
  render(html: string): Promise<Buffer>;
  inspect(pdf: Buffer): Promise<{ pages: number; text: string }>;
}

export interface PdfAudit {
  pages: number;
  pageBudget: number;
  trimmed: string[];
  textLayer: { ok: boolean; problems: string[] };
}

export function defaultPdfTools(): PdfTools {
  return {
    async render(html) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
      } finally {
        await browser.close();
      }
    },
    async inspect(pdf) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse');
      const r = await pdfParse(pdf);
      return { pages: r.numpages, text: r.text };
    },
  };
}

const LIGATURES = /[ﬀ-ﬆ�]/;

export function auditTextLayer(text: string, resume: MasterResume): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const expected = [
    resume.basics.summary ? 'SUMMARY' : null,
    resume.skills?.length ? 'SKILLS' : null,
    resume.work?.length ? 'EXPERIENCE' : null,
    resume.education?.length ? 'EDUCATION' : null,
  ].filter(Boolean) as string[];
  const upper = text.toUpperCase();
  let last = -1;
  for (const h of expected) {
    const at = upper.indexOf(h, last + 1);
    if (at === -1) problems.push(`section "${h}" missing from text layer`);
    else if (at < last) problems.push(`section "${h}" out of order`);
    else last = at;
  }
  if (!text.includes(resume.basics.name)) problems.push('name missing from text layer');
  if (LIGATURES.test(text)) problems.push('ligature or replacement characters in text layer');
  // Every printed employer must survive extraction.
  for (const w of resume.work ?? []) if (!text.includes(w.name)) problems.push(`employer "${w.name}" missing from text layer`);
  return { ok: problems.length === 0, problems };
}

/** Remove the lowest-scoring printed bullet that is not its role's last. Returns its text or null. */
export function trimOne(resume: MasterResume, printed: TailoredResume['printed']): string | null {
  // Lowest relevance first; on ties drop projects, then the bullet the author listed last.
  const candidates = [...printed].sort((a, b) => a.score - b.score || (a.section === b.section ? 0 : a.section === 'project' ? -1 : 1) || b.order - a.order);
  for (const b of candidates) {
    const holders = [...(resume.projects ?? []), ...(resume.work ?? [])];
    const owner = holders.find((h) => h.highlights?.includes(b.text));
    if (!owner) continue;
    const isProject = (resume.projects ?? []).includes(owner as any);
    if (!isProject && owner.highlights!.length <= 1) continue;
    owner.highlights = owner.highlights!.filter((t) => t !== b.text);
    printed.splice(printed.indexOf(b), 1);
    return b.text;
  }
  return null;
}

export async function renderResumePdf(
  tailored: TailoredResume,
  job: JobPosting,
  options: { tools?: PdfTools; pageBudget?: number; maxTrims?: number } = {},
): Promise<{ pdf: Buffer; html: string; markdown: string; resume: MasterResume; audit: PdfAudit }> {
  const tools = options.tools ?? defaultPdfTools();
  const pageBudget = options.pageBudget ?? 1;
  const resume: MasterResume = JSON.parse(JSON.stringify(tailored.resume));
  const printed = tailored.printed.map((p) => ({ ...p }));
  const trimmed: string[] = [];
  let html = renderResumeHtml(resume, job);
  let pdf = await tools.render(html);
  let info = await tools.inspect(pdf);
  while (info.pages > pageBudget && trimmed.length < (options.maxTrims ?? 20)) {
    const removed = trimOne(resume, printed);
    if (!removed) break;
    trimmed.push(removed);
    html = renderResumeHtml(resume, job);
    pdf = await tools.render(html);
    info = await tools.inspect(pdf);
  }
  return {
    pdf, html, markdown: renderResumeMarkdown(resume), resume,
    audit: { pages: info.pages, pageBudget, trimmed, textLayer: auditTextLayer(info.text, resume) },
  };
}
