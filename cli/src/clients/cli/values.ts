import { text } from "@optique/core/message";
import type { NonEmptyString, ValueParser } from "@optique/core/valueparser";
import { appName, domain, examples, serverName, subdomain } from "../../core/fleet/brand.ts";
import type { Result } from "../../result.ts";

/** An Optique value parser that mints a brand: arguments arrive already validated. */
const minting = <T extends string>(
  metavar: NonEmptyString,
  mint: (input: string) => Result<T, string>,
  placeholder: T,
): ValueParser<"sync", T> => ({
  mode: "sync",
  metavar,
  placeholder,
  parse: (input) => {
    const minted = mint(input);
    return minted.ok ? { success: true, value: minted.value } : { success: false, error: [text(minted.error)] };
  },
  format: (value) => value,
});

export const appNameParser = minting("APP", appName, examples.app);
export const serverNameParser = minting("SERVER", serverName, examples.server);
export const domainParser = minting("DOMAIN", domain, examples.domain);
export const subdomainParser = minting("SUBDOMAIN", subdomain, examples.subdomain);
