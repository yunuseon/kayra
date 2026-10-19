import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { appOwner, jobOwner } from "../../src/deployer/brand.ts";
import { empty, enqueue, finish, type Queue, type Request } from "../../src/deployer/runs/queue.ts";
import { name } from "./support.ts";

const push = (app: string, ref = "main"): Request => ({
  owner: appOwner(name(app)),
  work: { kind: "deploy", app: name(app), ref, why: "push" },
});
const gc: Request = { owner: jobOwner("gc"), work: { kind: "job", job: "gc", dryRun: false } };

const after = (queue: Queue, ...requests: readonly Request[]): Queue =>
  requests.reduce((so, request) => enqueue(so, request).queue, queue);

test("a request starts at once while there is room", () => {
  const { queue, start } = enqueue(empty(2), push("shop"));
  deepStrictEqual(start, [push("shop")]);
  deepStrictEqual(queue.running, [push("shop")]);
});

test("one run per app: a second waits, a third replaces it", () => {
  const queue = after(empty(2), push("shop", "a"), push("shop", "b"), push("shop", "c"));
  deepStrictEqual(queue.running, [push("shop", "a")]);
  deepStrictEqual(queue.waiting, [push("shop", "c")]);
  const next = finish(queue, appOwner(name("shop")));
  deepStrictEqual(next.start, [push("shop", "c")]);
});

test("the limit holds across apps", () => {
  const queue = after(empty(2), push("a"), push("b"), push("c"));
  deepStrictEqual(queue.running.map((r) => r.owner), ["a", "b"]);
  deepStrictEqual(finish(queue, appOwner(name("a"))).start, [push("c")]);
});

test("the registry GC waits for everything and runs alone", () => {
  const queue = after(empty(2), push("a"), gc, push("b"));
  deepStrictEqual(queue.running, [push("a")]);
  deepStrictEqual(queue.waiting, [gc, push("b")]);
  const gcStarts = finish(queue, appOwner(name("a")));
  deepStrictEqual(gcStarts.start, [gc]);
  deepStrictEqual(enqueue(gcStarts.queue, push("c")).start, []);
  deepStrictEqual(finish(gcStarts.queue, jobOwner("gc")).start, [push("b")]);
});
