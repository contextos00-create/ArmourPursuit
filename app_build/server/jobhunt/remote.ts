'use strict';

/**
 * Optional access from the person's own phone. Off until a passcode is set
 * on the computer itself. A device that is not the computer must present the
 * passcode once; it then holds a random session token (only its hash is kept).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

interface RemoteFile {
  salt: string;
  hash: string;
  sessions: { hash: string; expires: number; label: string }[];
}

const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
let fails: { count: number; until: number } = { count: 0, until: 0 };

function load(path: string): RemoteFile | null {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, 'utf8'));
    return f && typeof f.salt === 'string' && typeof f.hash === 'string' ? { ...f, sessions: Array.isArray(f.sessions) ? f.sessions : [] } : null;
  } catch {
    return null;
  }
}

function save(path: string, f: RemoteFile) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(f, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const derive = (passcode: string, salt: string) => scryptSync(passcode, Buffer.from(salt, 'hex'), 32).toString('hex');

export function remoteStatus(path: string, now = Date.now()): { enabled: boolean; devices: number } {
  const f = load(path);
  return { enabled: !!f, devices: f ? f.sessions.filter((s) => s.expires > now).length : 0 };
}

/** Turn phone access on (or change the passcode). Signs out every device. */
export function setPasscode(path: string, passcode: string) {
  if (typeof passcode !== 'string' || passcode.length < 8 || passcode.length > 200) throw new Error('Use a passcode of at least 8 characters.');
  const salt = randomBytes(16).toString('hex');
  save(path, { salt, hash: derive(passcode, salt), sessions: [] });
  fails = { count: 0, until: 0 };
}

/** Turn phone access off and sign out every device. */
export function disableRemote(path: string) {
  rmSync(path, { force: true });
}

/** Check a passcode and start a session. Returns the token to store in a cookie. */
export function login(path: string, passcode: string, label = '', now = Date.now()): { token: string; maxAgeSeconds: number } {
  const f = load(path);
  if (!f) throw new Error('Phone access is turned off. Turn it on from the computer first.');
  if (fails.until > now) throw new Error(`Too many wrong passcodes. Try again in ${Math.ceil((fails.until - now) / 60_000)} min.`);
  const given = Buffer.from(derive(String(passcode ?? ''), f.salt), 'hex');
  if (!timingSafeEqual(given, Buffer.from(f.hash, 'hex'))) {
    fails.count += 1;
    if (fails.count >= MAX_FAILS) fails = { count: 0, until: now + LOCK_MS };
    throw new Error('Wrong passcode.');
  }
  fails = { count: 0, until: 0 };
  const token = randomBytes(32).toString('hex');
  const expires = now + SESSION_DAYS * 86_400_000;
  save(path, { ...f, sessions: [...f.sessions.filter((s) => s.expires > now), { hash: digest(token), expires, label: label.slice(0, 80) }].slice(-10) });
  return { token, maxAgeSeconds: SESSION_DAYS * 86_400 };
}

export function validSession(path: string, token: string | undefined | null, now = Date.now()): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const f = load(path);
  if (!f) return false;
  const want = Buffer.from(digest(token), 'hex');
  return f.sessions.some((s) => s.expires > now && timingSafeEqual(Buffer.from(s.hash, 'hex'), want));
}

/** Test hook. */
export function resetThrottle() {
  fails = { count: 0, until: 0 };
}
