import { text } from "@optique/core/message";
import type { NonEmptyString, ValueParser } from "@optique/core/valueparser";
import { appName, domain, examples, serverName, subdomain } from "../../core/fleet/brand.ts";
import type { Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** An Optique value parser that mints a brand: arguments arrive already validated. */
const minting = <T extends string>(
  metavar: NonEmptyString,
  mint: (input: string) => Result<T, string>,
  placeholder: T,
) => typed<ValueParser<"sync", T>>({
  mode: "sync",
  metavar,
  placeholder,
  parse: (input) => {
    const minted = mint(input);
    return minted.ok ? { success: true, value: minted.value } as const : { success: false, error: [text(minted.error)] } as const;
  },
  format: (value) => value,
});

export const appNameParser = minting("APP", appName, examples.app);
export const serverNameParser = minting("SERVER", serverName, examples.server);
export const domainParser = minting("DOMAIN", domain, examples.domain);
export const subdomainParser = minting("SUBDOMAIN", subdomain, examples.subdomain);
