import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { all, err, flatMap, map, ok } from "../src/lib/result.ts";

test("map and flatMap pass errors through untouched", () => {
  deepStrictEqual(map(ok(2), (n) => n * 2), ok(4));
  deepStrictEqual(map(err("no"), (n: number) => n * 2), err("no"));
  deepStrictEqual(flatMap(ok(2), () => err("later")), err("later"));
});

test("all collects values, or stops at the first error", () => {
  deepStrictEqual(all([ok(1), ok(2)]), ok([1, 2]));
  deepStrictEqual(all([ok(1), err("a"), err("b")]), err("a"));
  deepStrictEqual(all([]), ok([]));
});
