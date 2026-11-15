'use strict';

/**
 * The one flat, fully-defaulted settings shape the command center edits.
 * preferences.json stays the source of truth; this maps to and from it and
 * validates everything a browser sends before it is written.
 */

import { notifySettings } from './notify';

const LEVELS = ['junior', 'mid', 'senior', 'staff'] as const;
const MODES = ['remote', 'hybrid', 'onsite'] as const;
const ATS = ['greenhouse', 'lever', 'ashby'] as const;

export interface Settings {
  // What to look for
  targetTitles: string[];
  titleKeywords: string[];
  excludeTitleKeywords: string[];
  locations: string[];
  workModes: (typeof MODES)[number][];
  seniority: '' | (typeof LEVELS)[number];
  salaryFloor: number;
  usOnly: boolean;
  needsSponsorship: boolean;
  blockedCompanies: string[];
  dreamCompanies: string[];
  // Where to look
  watchlist: { ats: (typeof ATS)[number]; slug: string; name: string }[];
  adzunaWhat: string[];
  adzunaWhere: string[];
  adzunaMaxDaysOld: number;
  // Volume and thresholds
  dailyTarget: number;
  autoTailorAt: number;
  approvalAt: number;
  hotScore: number;
  hotExtra: number;
  // Applying
  perCompany: number;
  maxSiteFailures: number;
  applyWaitMinutes: number;
  applyWindow: 'auto' | 'visible' | 'hidden';
  autoSubmit: boolean;
  // Schedule
  discoveryEveryMinutes: number;
  inboxEveryMinutes: number;
  activeStart: number;
  activeEnd: number;
  digestHour: number;
  digestMinute: number;
  // Notifications
  notifyEnabled: boolean;
  notifySms: boolean;
  notifyBrowser: boolean;
  /** Kinds of notification that are turned off. */
  notifyOff: string[];
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  /** Top matches and interview reminders still come through during quiet hours. */
  quietUrgent: boolean;
  // Agent
  agentInstructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  targetTitles: [], titleKeywords: [], excludeTitleKeywords: [], locations: [], workModes: [], seniority: '', salaryFloor: 0,
  usOnly: false, needsSponsorship: false, blockedCompanies: [], dreamCompanies: [],
  watchlist: [], adzunaWhat: [], adzunaWhere: [], adzunaMaxDaysOld: 7,
  dailyTarget: 10, autoTailorAt: 80, approvalAt: 65, hotScore: 85, hotExtra: 3,
  perCompany: 2, maxSiteFailures: 3, applyWaitMinutes: 30, applyWindow: 'auto', autoSubmit: false,
  discoveryEveryMinutes: 60, inboxEveryMinutes: 5, activeStart: 7, activeEnd: 21, digestHour: 18, digestMinute: 30,
  notifyEnabled: true, notifySms: true, notifyBrowser: false, notifyOff: [], quietEnabled: false, quietStart: 21, quietEnd: 8, quietUrgent: true,
  agentInstructions: '',
};

const list = (v: unknown, max = 80): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 120)).filter(Boolean))].slice(0, max) : [];
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** preferences.json contents to the flat settings the page edits. */
export function toSettings(prefs: any): Settings {
  const p = prefs ?? {};
  const d = DEFAULT_SETTINGS;
  const where = p.adzuna?.where;
  const n = notifySettings(p);
  return {
    notifyEnabled: n.enabled, notifySms: n.sms, notifyBrowser: n.browser, notifyOff: n.off,
    quietEnabled: n.quiet, quietStart: n.quietStart, quietEnd: n.quietEnd, quietUrgent: n.quietUrgent,
    targetTitles: list(p.targetTitles), titleKeywords: list(p.titleKeywords), excludeTitleKeywords: list(p.excludeTitleKeywords),
    locations: list(p.locations), workModes: list(p.workModes).filter((m) => (MODES as readonly string[]).includes(m)) as Settings['workModes'],
    seniority: oneOf(p.seniority, LEVELS, '' as any), salaryFloor: int(p.salaryFloor, 0, 1_000_000, d.salaryFloor),
    usOnly: p.country === 'US', needsSponsorship: p.needsSponsorship === true,
    blockedCompanies: list(p.blockedCompanies), dreamCompanies: list(p.dreamCompanies),
    watchlist: (Array.isArray(p.watchlist) ? p.watchlist : [])
      .filter((w: any) => w && (ATS as readonly string[]).includes(w.ats) && /^[a-z0-9-_.]{1,60}$/i.test(String(w.slug ?? '')))
      .slice(0, 200)
      .map((w: any) => ({ ats: w.ats, slug: String(w.slug), name: typeof w.name === 'string' ? w.name.slice(0, 80) : '' })),
    adzunaWhat: list(p.adzuna?.what), adzunaWhere: list(typeof where === 'string' ? [where] : where),
    adzunaMaxDaysOld: int(p.adzuna?.maxDaysOld, 1, 60, d.adzunaMaxDaysOld),
    dailyTarget: int(p.dailyTarget, 1, 50, d.dailyTarget), autoTailorAt: int(p.autoTailorAt, 0, 100, d.autoTailorAt),
    approvalAt: int(p.approvalAt, 0, 100, d.approvalAt), hotScore: int(p.hotScore, 0, 100, d.hotScore), hotExtra: int(p.hotExtra, 0, 20, d.hotExtra),
    perCompany: int(p.apply?.perCompany, 1, 20, d.perCompany), maxSiteFailures: int(p.apply?.maxSiteFailures, 1, 20, d.maxSiteFailures),
    applyWaitMinutes: int(p.apply?.waitMinutes, 1, 180, d.applyWaitMinutes), applyWindow: oneOf(p.apply?.window, ['auto', 'visible', 'hidden'] as const, 'auto'),
    autoSubmit: p.autoSubmit === true,
    discoveryEveryMinutes: int(p.schedule?.discoveryEveryMinutes, 15, 1440, d.discoveryEveryMinutes),
    inboxEveryMinutes: int(p.schedule?.inboxEveryMinutes, 1, 240, d.inboxEveryMinutes),
    activeStart: int(p.schedule?.activeHours?.[0], 0, 23, d.activeStart), activeEnd: int(p.schedule?.activeHours?.[1], 1, 24, d.activeEnd),
    digestHour: int(p.schedule?.digestAt?.hour, 0, 23, d.digestHour), digestMinute: int(p.schedule?.digestAt?.minute, 0, 59, d.digestMinute),
    agentInstructions: typeof p.agentInstructions === 'string' ? p.agentInstructions.slice(0, 2000) : '',
  };
}

/**
 * Apply edited settings on top of the saved preferences. Unknown saved keys
 * are kept. Empty lists are removed so the built-in defaults apply again.
 */
export function mergeSettings(prefs: any, input: unknown): any {
  const s = toSettings(fromFlat(input));
  const next: any = { ...(prefs ?? {}) };
  const setList = (key: string, v: string[]) => (v.length ? (next[key] = v) : delete next[key]);
  setList('targetTitles', s.targetTitles);
  setList('titleKeywords', s.titleKeywords);
  setList('excludeTitleKeywords', s.excludeTitleKeywords);
  setList('locations', s.locations);
  setList('workModes', s.workModes);
  setList('blockedCompanies', s.blockedCompanies);
  setList('dreamCompanies', s.dreamCompanies);
  if (s.seniority) next.seniority = s.seniority; else delete next.seniority;
  if (s.salaryFloor) next.salaryFloor = s.salaryFloor; else delete next.salaryFloor;
  if (s.usOnly) next.country = 'US'; else delete next.country;
  next.needsSponsorship = s.needsSponsorship;
  next.watchlist = s.watchlist.map((w) => ({ ats: w.ats, slug: w.slug, ...(w.name ? { name: w.name } : {}) }));
  if (s.adzunaWhat.length) next.adzuna = { ...(next.adzuna ?? {}), what: s.adzunaWhat, where: s.adzunaWhere, maxDaysOld: s.adzunaMaxDaysOld };
  else delete next.adzuna;
  Object.assign(next, { dailyTarget: s.dailyTarget, autoTailorAt: s.autoTailorAt, approvalAt: Math.min(s.approvalAt, s.autoTailorAt), hotScore: s.hotScore, hotExtra: s.hotExtra });
  next.apply = { ...(next.apply ?? {}), perCompany: s.perCompany, maxSiteFailures: s.maxSiteFailures, waitMinutes: s.applyWaitMinutes, window: s.applyWindow };
  next.autoSubmit = s.autoSubmit;
  next.schedule = {
    discoveryEveryMinutes: s.discoveryEveryMinutes, inboxEveryMinutes: s.inboxEveryMinutes,
    activeHours: [s.activeStart, Math.max(s.activeEnd, s.activeStart + 1)], digestAt: { hour: s.digestHour, minute: s.digestMinute },
  };
  next.notifications = { enabled: s.notifyEnabled, sms: s.notifySms, browser: s.notifyBrowser, off: s.notifyOff, quiet: s.quietEnabled, quietStart: s.quietStart, quietEnd: s.quietEnd, quietUrgent: s.quietUrgent };
  if (s.agentInstructions.trim()) next.agentInstructions = s.agentInstructions.trim(); else delete next.agentInstructions;
  return next;
}

/** Flat settings from the page into the nested preferences shape toSettings reads. */
function fromFlat(input: unknown): any {
  const i: any = input && typeof input === 'object' ? input : {};
  return {
    ...i,
    country: i.usOnly ? 'US' : undefined,
    notifications: 'notifyEnabled' in i
      ? { enabled: i.notifyEnabled, sms: i.notifySms, browser: i.notifyBrowser, off: i.notifyOff, quiet: i.quietEnabled, quietStart: i.quietStart, quietEnd: i.quietEnd, quietUrgent: i.quietUrgent }
      : i.notifications,
    adzuna: { what: i.adzunaWhat, where: i.adzunaWhere, maxDaysOld: i.adzunaMaxDaysOld },
    apply: { perCompany: i.perCompany, maxSiteFailures: i.maxSiteFailures, waitMinutes: i.applyWaitMinutes, window: i.applyWindow },
    schedule: {
      discoveryEveryMinutes: i.discoveryEveryMinutes, inboxEveryMinutes: i.inboxEveryMinutes,
      activeHours: [i.activeStart, i.activeEnd], digestAt: { hour: i.digestHour, minute: i.digestMinute },
    },
  };
}
