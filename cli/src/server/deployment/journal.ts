/* The journal owns a live lock and serializes I/O across its mutable lifetime. */
/* eslint-disable functional/no-let, functional/prefer-immutable-types */
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JournalValue = null | boolean | number | string | readonly JournalValue[] | { readonly [key: string]: JournalValue };

// SQLite holds only the OS lock. The journal is a separately synchronized JSON file.
// Never delete or replace the lock database: another writer could lock a new inode.
export const openJournal = async (directory: string) => {
  const lock = new DatabaseSync(join(directory, 'writer-lock.sqlite'));
  const statePath = join(directory, 'state.json');
  const markerPath = join(directory, 'initialized');
  // Keep the established committed marker so an older deployer can read a
  // completed initialization after a downgrade.
  const committedMarker = 'kayra-journal-v1\n';
  const preparingMarker = 'kayra-journal-v2:preparing\n';
  let hasState = false;
  let initialized = false;
  let preparing = false;
  const atomicReplace = async (path: string, content: string) => {
    const tempPath = join(directory, `.journal-${randomUUID()}.tmp`);
    let temporary = false;
    try {
      const file = await open(tempPath, 'wx', 0o600);
      temporary = true;
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempPath, path);
      temporary = false;
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      if (temporary) await unlink(tempPath).catch(() => undefined);
    }
  };
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    try {
      const marker = await readFile(markerPath, 'utf8');
      if (marker === preparingMarker) preparing = true;
      else if (marker === committedMarker) initialized = true;
      else throw new Error('journal initialization marker is invalid');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    try {
      JSON.parse(await readFile(statePath, 'utf8'));
      hasState = true;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if ((initialized && !hasState) || (!initialized && !preparing && hasState)) {
      throw new Error('journal initialization and state disagree; intervention required');
    }
    // The initial write could have been interrupted after making its state durable
    // but before acknowledging it. Preserve that state; never create a new one.
    if (preparing && hasState) {
      await atomicReplace(markerPath, committedMarker);
      initialized = true;
      preparing = false;
    }
  } catch (error) {
    lock.close();
    throw error;
  }

  let closed = false;
  let pending = Promise.resolve();
  let failed = false;
  const read = () => {
    if (closed) throw new Error('journal is closed');
    const operation = pending.then(async () => {
      if (failed) throw new Error('journal write failed; reopen and reconcile');
      try {
        const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
        return parsed;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && !hasState) return undefined;
        failed = true;
        throw error;
      }
    });
    pending = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const write = (value: JournalValue) => {
    if (closed) throw new Error('journal is closed');
    const content = JSON.stringify(value);
    const operation = pending.then(async () => {
      if (failed) throw new Error('journal write failed; reopen and reconcile');
      try {
        if (!initialized) {
          if (!preparing) {
            await atomicReplace(markerPath, preparingMarker);
            preparing = true;
          }
        }
        await atomicReplace(statePath, content);
        hasState = true;
        if (!initialized) {
          await atomicReplace(markerPath, committedMarker);
          initialized = true;
          preparing = false;
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    pending = operation.catch(() => undefined);
    return operation;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await pending;
    lock.close();
  };
  return { read, write, close };
};
