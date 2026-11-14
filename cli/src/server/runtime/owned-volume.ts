import { z } from "zod";
import { parseOwnedVolume, volumeActionSchema } from "../../contracts/owned-volume.ts";
import type { OwnedVolume, OwnedVolumePort, VolumeAttachments, VolumeObservation, VolumeReceipt, VolumeWrite } from "../../contracts/owned-volume.ts";
import { typed } from "../../lib/typed.ts";
import type { dockerApi } from "./docker-api.ts";

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string) => record(value) ? value[key] : undefined;
const labels = (volume: OwnedVolume) => Object.freeze({ "com.kayra.app": volume.app, "com.kayra.data-owner": volume.dataOwner,
  "com.kayra.volume-key": volume.key, "com.kayra.volume-allocation": volume.allocation, "com.kayra.volume-version": "1" });
const receipt = (volume: OwnedVolume, input: unknown) => {
  const actual = field(input, "Labels"); const expected = labels(volume); const options = field(input, "Options"); const createdAt = field(input, "CreatedAt");
  return field(input, "Name") === volume.name && field(input, "Driver") === "local" && field(input, "Scope") === "local" &&
    record(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value) &&
    (options === null || record(options) && Object.keys(options).length === 0) && typeof createdAt === "string" && createdAt.length <= 128 && Number.isFinite(Date.parse(createdAt))
    ? typed<VolumeReceipt>({ volume, createdAt }) : undefined;
};
const mountReferences = (mounts: unknown, volume: string) => {
  if (mounts === undefined || mounts === null) return false;
  if (!Array.isArray(mounts)) throw new Error("invalid mount observation");
  return mounts.some((mount: unknown) => {
    if (!record(mount) || !["bind", "tmpfs", "volume"].includes(String(mount["Type"]))) throw new Error("invalid mount observation");
    if (mount["Type"] !== "volume") return false;
    if (typeof mount["Source"] !== "string") throw new Error("invalid volume source");
    return mount["Source"] === volume;
  });
};

/** Local named volumes only. Lifecycle fencing and data-retention decisions stay with the coordinator. */
export const ownedVolumes = (api: Pick<ReturnType<typeof dockerApi>, "request">, now: () => number = Date.now) => {
  const observe = async (input: OwnedVolume) => {
    const parsed = parseOwnedVolume(input); if (!parsed.ok) return typed<VolumeObservation>({ status: "foreign" }); const volume = parsed.value;
    try {
      const reply = await api.request("GET", `/volumes/${encodeURIComponent(volume.name)}`);
      if (reply.status === 404) return typed<VolumeObservation>({ status: "absent" });
      if (reply.status !== 200) return typed<VolumeObservation>({ status: "unavailable" });
      const owned = receipt(volume, reply.value);
      return owned === undefined ? typed<VolumeObservation>({ status: "foreign" }) : typed<VolumeObservation>({ status: "owned", receipt: owned });
    } catch { return typed<VolumeObservation>({ status: "unavailable" }); }
  };
  const attachments = async (input: OwnedVolume) => {
    const parsed = parseOwnedVolume(input); if (!parsed.ok) return typed<VolumeAttachments>({ status: "unavailable" }); const volume = parsed.value;
    try {
      const [containers, services] = await Promise.all([api.request("GET", "/containers/json?all=1"), api.request("GET", "/services")]);
      if (containers.status !== 200 || services.status !== 200 || !Array.isArray(containers.value) || !Array.isArray(services.value)) return typed<VolumeAttachments>({ status: "unavailable" });
      const containerIds = containers.value.flatMap((container: unknown) => {
        const id = field(container, "Id"); const mounts = field(container, "Mounts");
        if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || !Array.isArray(mounts)) throw new Error("invalid container observation");
        const attached = mounts.some((mount: unknown) => {
          if (!record(mount) || !["bind", "tmpfs", "volume"].includes(String(mount["Type"]))) throw new Error("invalid container mount");
          if (mount["Type"] !== "volume") return false;
          if (typeof mount["Name"] !== "string") throw new Error("invalid container volume");
          return mount["Name"] === volume.name;
        });
        return attached ? Object.freeze([id]) : Object.freeze([]);
      });
      const serviceIds = services.value.flatMap((service: unknown) => {
        const id = field(service, "ID"); const spec = field(service, "Spec"); const previous = field(service, "PreviousSpec");
        if (typeof id !== "string" || !/^[a-z0-9]{25}$/.test(id) || !record(spec) || !record(field(field(spec, "TaskTemplate"), "ContainerSpec")) ||
          previous !== undefined && previous !== null && (!record(previous) || !record(field(field(previous, "TaskTemplate"), "ContainerSpec")))) throw new Error("invalid service observation");
        return [spec, previous].some((value) => mountReferences(field(field(field(value, "TaskTemplate"), "ContainerSpec"), "Mounts"), volume.name)) ? Object.freeze([id]) : Object.freeze([]);
      });
      return typed<VolumeAttachments>({ status: "observed", containers: Object.freeze([...new Set(containerIds)].toSorted()), services: Object.freeze([...new Set(serviceIds)].toSorted()) });
    } catch { return typed<VolumeAttachments>({ status: "unavailable" }); }
  };
  const action = (input: unknown) => {
    const parsed = volumeActionSchema.safeParse(input); const left = parsed.success ? parsed.data.deadline - now() : 0;
    return parsed.success && left > 0 && left <= 90000 ? parsed.data : undefined;
  };
  return typed<OwnedVolumePort>(Object.freeze({ observe, attachments,
    create: async (input) => {
      const intent = action(input); if (intent === undefined) return "refused";
      const before = await observe(intent.volume); if (before.status === "owned") return "acknowledged";
      if (before.status !== "absent") return before.status === "foreign" ? "conflict" : "uncertain";
      const left = intent.deadline - now(); if (left <= 0) return "refused";
      try {
        const reply = await api.request("POST", "/volumes/create", { Name: intent.volume.name, Driver: "local", DriverOpts: {}, Labels: labels(intent.volume) }, { timeoutMs: Math.min(left, 10000) });
        return reply.status === 201 && receipt(intent.volume, reply.value) !== undefined ? "acknowledged" : "uncertain";
      } catch { return "uncertain"; }
    },
    remove: async (input, expected) => {
      const intent = action(input); const identity = parseOwnedVolume(expected.volume); const createdAt = expected.createdAt;
      if (intent === undefined || !identity.ok || JSON.stringify(identity.value) !== JSON.stringify(intent.volume) || !z.string().max(128).refine((value) => Number.isFinite(Date.parse(value))).safeParse(createdAt).success) return "refused";
      const before = await observe(intent.volume);
      if (before.status !== "owned" && before.status !== "absent") return before.status === "foreign" ? "conflict" : "uncertain";
      if (before.status === "owned" && before.receipt.createdAt !== createdAt) return "conflict";
      const attached = await attachments(intent.volume); if (attached.status !== "observed") return "uncertain";
      if (attached.containers.length > 0 || attached.services.length > 0) return "attached";
      if (before.status === "absent") return "acknowledged";
      const fresh = await observe(intent.volume); if (fresh.status !== "owned" || fresh.receipt.createdAt !== createdAt) return "conflict";
      const left = intent.deadline - now(); if (left <= 0) return "refused";
      try {
        const reply = await api.request("DELETE", `/volumes/${encodeURIComponent(intent.volume.name)}?force=false`, undefined, { timeoutMs: Math.min(left, 10000) });
        return typed<VolumeWrite>(reply.status === 204 || reply.status === 404 ? "acknowledged" : reply.status === 409 ? "attached" : "uncertain");
      } catch { return "uncertain"; }
    },
  }));
};
