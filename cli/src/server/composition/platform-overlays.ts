/* eslint-disable functional/no-let -- composition owns the platform journal lifetimes */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppOverlayPort } from "../../contracts/app-overlay.ts";
import { parseRegistrationOwnership } from "../../contracts/registration-ownership.ts";
import type { RegistrationOwnership } from "../../contracts/registration-ownership.ts";
import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import { names } from "../../lib/names.ts";
import { appOverlayAllocation } from "../platform/app-overlay-allocation.ts";
import { appOverlayRequest } from "../platform/app-overlay.ts";
import { openJournal } from "../deployment/journal.ts";

const request = z.object({ app: z.string().max(48).regex(names.app.pattern), generation: z.uuid(), ticket: z.string().max(80) }).strict();
type Ports = {
  readonly directory: string;
  readonly ownership: (app: string, generation: string, ticket: string) => Promise<RegistrationOwnership>;
  readonly host: () => Promise<SwarmAuthority | undefined>;
  readonly authorize: (reference: RegistrationOwnership) => Promise<boolean>;
  readonly native: AppOverlayPort;
};

/** An internal platform command in the existing privileged process, independent of rollout policy. */
export const platformOverlayControl = (ports: Ports) => {
  const entries = new Map<string, Promise<{ readonly journal: Awaited<ReturnType<typeof openJournal>>; readonly allocation: ReturnType<typeof appOverlayAllocation> }>>();
  let closed = false;
  const isClosed = () => closed;
  const provision = async (input: unknown) => {
    const checked = request.safeParse(input); if (!checked.success) return undefined;
    if (isClosed()) throw new Error("platform overlay owner is closed");
    const { app, generation, ticket } = checked.data;
    const checkedOwner = parseRegistrationOwnership(await ports.ownership(app, generation, ticket));
    if (!checkedOwner.ok || checkedOwner.value.registration.app !== app || checkedOwner.value.registration.registrationGeneration !== generation || checkedOwner.value.registration.actionId !== ticket) throw new Error("platform overlay ownership scope disagrees");
    const owner = checkedOwner.value; const host = await ports.host();
    if (host === undefined) throw new Error("experimental platform overlay is not enabled");
    const planned = appOverlayRequest(owner.registration, owner.runtime, host, randomUUID(), Date.now() + 90000);
    if (!planned.ok) throw new Error(planned.error);
    const scope = planned.value.scope;
    if (isClosed()) throw new Error("platform overlay owner is closed");
    const key = owner.registration.incarnation;
    let entry = entries.get(key);
    if (entry === undefined) {
      // eslint-disable-next-line functional/prefer-immutable-types -- the composition owns this live journal handle
      entry = (async () => {
        const path = join(ports.directory, key); await mkdir(path, { recursive: true, mode: 0o700 });
        const journal = await openJournal(path);
        const allocation = appOverlayAllocation({ storage: journal, native: ports.native, now: Date.now, newId: randomUUID,
          authorize: async (reference) => {
            const current = await ports.host();
            return current?.node === scope.node && current.cluster === scope.cluster && await ports.authorize(reference);
          },
        });
        return Object.freeze({ journal, allocation });
      })();
      // eslint-disable-next-line functional/immutable-data -- one shared opening promise prevents competing journal owners
      entries.set(key, entry);
    }
    const opened = await entry;
    if (isClosed()) throw new Error("platform overlay owner is closed");
    const result = await opened.allocation.provision(owner, scope);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return Object.freeze({ provision, close: async () => {
    closed = true;
    await Promise.all([...entries.values()].map(async (entry) => {
      const opened = await entry.catch(() => undefined); if (opened === undefined) return;
      await opened.allocation.settle(); await opened.journal.close();
    }));
  } });
};
