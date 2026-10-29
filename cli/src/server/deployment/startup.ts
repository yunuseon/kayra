import { openJournal } from './journal.ts';

/** The lock-only foundation does not claim recovery of any legacy Compose run. */
// eslint-disable-next-line functional/prefer-immutable-types -- the returned handle owns a live OS lock
export const startWithLifecycle = async (directory: string, start: () => void) => {
  const journal = await openJournal(directory);
  try {
    const state = await journal.read();
    if (state === undefined) {
      await journal.write({ version: 1, mode: 'legacy-compose-lock-only' });
    } else if (typeof state !== 'object' || state === null || Array.isArray(state) ||
      Object.keys(state).length !== 2 || Reflect.get(state, 'version') !== 1 || Reflect.get(state, 'mode') !== 'legacy-compose-lock-only') {
      throw new Error('lifecycle journal state is unsupported or corrupt');
    }
  } catch (error) {
    await journal.close();
    throw error;
  }
  try {
    start();
    return journal;
  } catch (error) {
    // Startup may already have opened listeners or scheduled work. Retain the
    // lock even if the caller catches the exception; the OS releases it on exit.
    process.once('exit', () => { void journal.close(); });
    throw error;
  }
};
