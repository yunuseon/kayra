/** A change to a state, as an answer lands: status's cells filling in. */
export type Update<S> = (state: S) => S;

/** The state all the updates make, drawn nowhere: for a stream that is no terminal. */
export const settle = async <S>(initial: S, updates: readonly Promise<Update<S>>[]): Promise<S> =>
  (await Promise.all(updates)).reduce((state, update) => update(state), initial);

/** Each state as the updates land, in the order they land: for a viewer elsewhere (the web interface). */
export const follow = async <S>(initial: S, updates: readonly Promise<Update<S>>[], each: (state: S) => void): Promise<S> => {
  type Landed = { readonly id: number; readonly update: Update<S> };
  const go = async (state: S, waiting: readonly { readonly id: number; readonly landed: Promise<Landed> }[]): Promise<S> => {
    each(state);
    if (waiting.length === 0) return state;
    const next = await Promise.race(waiting.map((one) => one.landed));
    return go(next.update(state), waiting.filter((one) => one.id !== next.id));
  };
  return go(initial, updates.map((update, id) => ({ id, landed: update.then((done) => ({ id, update: done })) })));
};
