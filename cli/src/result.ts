export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  result.ok ? ok(f(result.value)) : result;

export const flatMap = <T, U, E>(
  result: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? f(result.value) : result);

export const all = <T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> =>
  results.reduce<Result<readonly T[], E>>(
    (acc, result) => flatMap(acc, (values) => map(result, (value) => [...values, value])),
    ok([]),
  );

export const mapError = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(f(result.error));

/** What `run` makes, or why it threw: for code that reads the disk, the one place an exception becomes a value. */
export const attempt = <T>(run: () => Result<T, string>, why: (error: string) => string): Result<T, string> => {
  try {
    return run();
  } catch (error) {
    return err(why(error instanceof Error ? error.message : String(error)));
  }
};
