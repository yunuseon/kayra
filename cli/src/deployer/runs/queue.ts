import { jobOwner, type JobName, type RunId } from "../brand.ts";
import type { Request } from "../../contracts/legacy-work.ts";
import type { JobWhy } from "../../contracts/reporting.ts";
import { typed } from "../../lib/typed.ts";

export type { Request, Work } from "../../contracts/legacy-work.ts";
export type { JobWhy, Why } from "../../contracts/reporting.ts";
export { describe, empty, enqueue, finish, type Queue } from "../../server/deployment/legacy-queue.ts";

export const jobRequest = (id: RunId, job: JobName, dryRun: boolean, why: JobWhy) =>
  typed<Request>({ id, owner: jobOwner(job), work: { kind: "job", job, dryRun, why } });
