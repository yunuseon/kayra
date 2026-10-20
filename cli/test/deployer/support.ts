import type { App } from "../../src/deployer/app.ts";
import { appName, runId, sha, type AppName, type RunId, type Sha } from "../../src/deployer/brand.ts";
import type { Result } from "../../src/lib/result.ts";

export const must = <T>(result: Result<T, string>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

export const name = (value: string): AppName => must(appName(value));
/** A run id, for requests whose id no test looks at. */
export const rid: RunId = must(runId("20261018T095848Z-0f9e8d"));
export const commit = (digit: string): Sha => must(sha(digit.repeat(40)));

export const shop: App = {
  name: name("shop"),
  repo: "https://github.com/example/shop.git",
  ref: "main",
  path: ".",
  hosts: ["www.shop.example.com"],
  secrets: ["DATABASE_PASSWORD"],
};
