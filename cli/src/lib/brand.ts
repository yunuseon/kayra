declare const brands: unique symbol;
/** A T that only its minting constructor can produce. */
export type Brand<T, B extends string> = T & { readonly [brands]: Readonly<Record<B, true>> };

/** For a schema's `.transform`: what passed it, branded B. The one place a brand is minted without a check of its own. */
export const branded = <B extends string>() => <T>(value: T) => value as Brand<T, B>;
