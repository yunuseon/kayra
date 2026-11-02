/* Same-object protection for disconnected prototypes only. Different wrappers,
 * raw journal access and different processes bypass this registry. The trusted
 * composition root must own the handle and the journal must provide its own
 * cross-process lock. A claim is retained for the lifetime of its consumer. */
const claims = new WeakMap<object, symbol>();

/** Acquire synchronously before any I/O. The returned release is for failed
 * initialization only, before any possibly committed write. */
export const claimJournal = (journal: object, message: string) => {
  if (claims.has(journal)) throw new Error(message);
  const token = Symbol("journal-owner");
  claims.set(journal, token);
  return () => {
    if (claims.get(journal) === token) {
      claims.delete(journal);
    }
  };
};
