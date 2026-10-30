import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { lifecycleActionId, parseLifecycleFence } from "../../src/server/deployment/lifecycle-fence.ts";
import { openLifecycleFenceStore } from "../../src/server/deployment/lifecycle-fence-store.ts";
import type { JournalValue } from "../../src/server/deployment/journal.ts";

const generation = "12345678-1234-4234-8234-123456789abc";

test("journal transitions serialize, and removal fences an already accepted deployment", async () => {
  // eslint-disable-next-line functional/no-let -- stand-in for the synchronized journal contents
  let contents: JournalValue | undefined;
  const journal = { read: () => Promise.resolve(contents), write: (value: JournalValue) => { contents = value; return Promise.resolve(); } };
  const store = openLifecycleFenceStore(journal);
  const initial = await store.initialize("shop-", generation);
  await store.settle(lifecycleActionId(initial, 1));
  const [running, fenced] = await Promise.all([store.beginWork("deploy"), store.requestRemoval()]);
  equal(running.lifecycle.phase, "registered");
  equal(fenced.lifecycle.phase, "removal-requested");
  if (fenced.lifecycle.active === null) throw new Error("expected held work");
  await rejects(store.beginWork("deploy"));
  // eslint-disable-next-line functional/no-let -- track whether observation ran before settlement
  let observations = 0;
  await rejects(store.startRemoval(() => { observations += 1; return Promise.resolve(["shop_db"]); }));
  equal(observations, 0);
  await store.settle(lifecycleActionId(fenced, fenced.lifecycle.active.sequence));
  await rejects(store.startRemoval(() => Promise.reject(new Error("observation unavailable"))), /observation unavailable/);
  equal((await store.read())?.lifecycle.phase, "removal-requested");
  const removing = await store.startRemoval(() => { observations += 1; return Promise.resolve(["shop_db"]); });
  equal(observations, 1);
  equal(removing.lifecycle.phase, "removing");
  deepStrictEqual(await store.read(), removing);
});

test("a lost write acknowledgement poisons the owner until the journal is reopened", async () => {
  // eslint-disable-next-line functional/no-let -- simulate a committed write whose response was lost
  let contents: JournalValue | undefined;
  const journal = { read: () => Promise.resolve(contents), write: (value: JournalValue) => { contents = value; return Promise.reject(new Error("lost acknowledgement")); } };
  const store = openLifecycleFenceStore(journal);
  await rejects(store.initialize("shop", generation), /lost acknowledgement/);
  await rejects(store.read(), /uncertain/);
  await rejects(store.initialize("shop", generation), /uncertain/);
  const reopened = openLifecycleFenceStore({ read: () => Promise.resolve(contents), write: (value: JournalValue) => { contents = value; return Promise.resolve(); } });
  const state = await reopened.initialize("shop", generation);
  equal(state.lifecycle.phase, "registering");
  await rejects(reopened.initialize("shop", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), /already initialized/);
});

test("volume observation waits for the previous settlement write to be acknowledged", async () => {
  // eslint-disable-next-line functional/no-let -- model durable storage and a delayed acknowledgement
  let contents: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- hold only the chosen settlement write
  let hold = false;
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const journal = {
    read: () => Promise.resolve(contents),
    write: async (value: JournalValue) => {
      if (hold) {
        entered.resolve(undefined);
        await release.promise;
      }
      contents = value;
    },
  };
  const store = openLifecycleFenceStore(journal);
  const registered = await store.initialize("shop", generation);
  await store.settle(lifecycleActionId(registered, 1));
  const work = await store.beginWork("deploy");
  await store.requestRemoval();
  hold = true;
  const settlement = store.settle(lifecycleActionId(work, 2));
  await entered.promise;
  // eslint-disable-next-line functional/no-let -- count callback invocations across queued operations
  let observations = 0;
  const removal = store.startRemoval(() => {
    observations += 1;
    const current = parseLifecycleFence(contents);
    if (!current.ok) throw new Error(current.error);
    deepStrictEqual(current.value.lifecycle, { phase: "removal-requested", active: null, removal: 3 });
    return Promise.resolve(["shop_db"]);
  });
  await Promise.resolve();
  equal(observations, 0);
  hold = false;
  release.resolve(undefined);
  await settlement;
  const removing = await removal;
  equal(observations, 1);
  equal(removing.lifecycle.phase, "removing");
});

test("invalid volume observations do not run accessors or advance removal", async () => {
  // eslint-disable-next-line functional/no-let -- stand-in for the synchronized journal contents
  let contents: JournalValue | undefined;
  const journal = { read: () => Promise.resolve(contents), write: (value: JournalValue) => { contents = value; return Promise.resolve(); } };
  const store = openLifecycleFenceStore(journal);
  const initial = await store.initialize("shop", generation);
  await store.settle(lifecycleActionId(initial, 1));
  const fenced = await store.requestRemoval();
  // eslint-disable-next-line functional/no-let -- verify no untrusted accessor was invoked
  let getterCalls = 0;
  const accessor = Object.defineProperty(["shop_db"], "0", { get: () => { getterCalls += 1; return "shop_db"; } });
  const sparse = new Array<string>(1);
  for (const volumes of [accessor, sparse, ["shop_db", "shop_db"], ["../other"]]) {
    await rejects(store.startRemoval(() => Promise.resolve(volumes)));
    deepStrictEqual(await store.read(), fenced);
  }
  equal(getterCalls, 0);
});
