import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export const AUTH_LOCK_STALE_MS = 30_000;
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/** Replace credentials without exposing them through umask-created temp files. */
export function writeJsonAtomic(file, value) {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o600; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temp, 'wx', mode);
    created = true;
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temp); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function compromised() {
  return Object.assign(new Error('credential lock ownership lost'), { code: 'ECOMPROMISED' });
}

/**
 * Keep MiniMax Code's empty-directory lock protocol and its 30-second lease.
 * proper-lockfile maintains the heartbeat; identity checks also fence writes
 * and release when a directory is replaced before the next heartbeat runs.
 * Timing overrides are used by fixture-only tests, not user configuration.
 */
export async function withAuthLock(lockPath, operation, {
  staleMs = AUTH_LOCK_STALE_MS, updateMs = 5_000, waitMs = 20_000, pollMs = 60,
} = {}) {
  const directory = `${lockPath}.lock`;
  const controller = new AbortController();
  let identity;
  const ownsDirectory = () => {
    try {
      const current = fs.statSync(directory, { bigint: true });
      return current.dev === identity.dev && current.ino === identity.ino
        && current.birthtimeNs === identity.birthtimeNs;
    } catch { return false; }
  };
  // The library also releases locks during process exit. Guard both paths so
  // neither an async release nor an exit hook removes a replacement lock.
  const guardedFs = {
    ...fs,
    utimes(target, atime, mtime, callback) {
      if (identity && !ownsDirectory()) {
        const error = compromised();
        controller.abort(error);
        callback(error);
        return;
      }
      fs.utimes(target, atime, mtime, callback);
    },
    rmdir(target, callback) {
      if (identity && !ownsDirectory()) { callback(compromised()); return; }
      fs.rmdir(target, callback);
    },
    rmdirSync(target) {
      if (identity && !ownsDirectory()) throw compromised();
      return fs.rmdirSync(target);
    },
  };
  const release = await lockfile.lock(lockPath, {
    realpath: false, stale: staleMs, update: updateMs, fs: guardedFs,
    retries: { retries: Math.ceil(waitMs / pollMs), factor: 1, minTimeout: pollMs, maxTimeout: pollMs },
    onCompromised: error => controller.abort(error),
  });
  const assertOwned = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!identity || !ownsDirectory()
      || Date.now() - fs.statSync(directory).mtimeMs >= staleMs) {
      const error = compromised();
      controller.abort(error);
      throw error;
    }
  };
  try {
    identity = fs.statSync(directory, { bigint: true });
    assertOwned();
    return await operation({ signal: controller.signal, assertOwned });
  } finally {
    controller.abort();
    try { await release(); }
    catch (error) {
      if (!['ERELEASED', 'ECOMPROMISED'].includes(error.code)) throw error;
    }
  }
}

/** The deadline covers response headers AND the complete response body. */
export async function fetchTextWithDeadline(url, init, signal, timeoutMs = AUTH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('credential renewal timed out')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, controller.signal]) });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}
