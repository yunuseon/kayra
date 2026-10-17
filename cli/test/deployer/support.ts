import type { App } from "../../src/deployer/app.ts";
import { appName, sha, type AppName, type Sha } from "../../src/deployer/brand.ts";
import type { Result } from "../../src/result.ts";

export const must = <T>(result: Result<T, string>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

export const name = (value: string): AppName => must(appName(value));
export const commit = (digit: string): Sha => must(sha(digit.repeat(40)));

export const shop: App = {
  name: name("shop"),
  repo: "https://github.com/example/shop.git",
  ref: "main",
  path: ".",
  hosts: ["www.shop.example.com"],
  secrets: ["DATABASE_PASSWORD"],
};
