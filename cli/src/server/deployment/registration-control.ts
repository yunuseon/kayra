import type { HttpPlanPort } from "../../contracts/http-plan.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { z } from "zod";
import { names } from "../../lib/names.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { registrationGenerationId } from "./lifecycle-envelope.ts";

const request = z.object({
  app: z.string().regex(names.app.pattern),
  generation: registrationGenerationId,
}).strict();
const reserveRequest = request.extend({ runtime: z.enum(["compose", "swarm"]).default("compose") });
const ticketRequest = request.extend({ ticket: z.string().max(80) });

type AppIndex = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>,
  "previewPlan" | "registrationPolicy" | "imagePins" | "prepareBuild" | "verifiedRegistration" | "prepareApp" | "reserveRegistration" | "submitRegistration" | "reconcileRegistration">>;

export type RegistrationPorts = {
  readonly index: AppIndex;
  readonly canRegister: (app: string) => Promise<boolean>;
  readonly builds?: BuildPorts | undefined;
  readonly runtimeEnabled?: ((runtime: Runtime) => Promise<boolean>) | undefined;
  readonly plans?: HttpPlanPort | undefined;
};
export const registrationControl = ({ index, canRegister, builds, runtimeEnabled = (runtime) => Promise.resolve(runtime === "compose"), plans }: RegistrationPorts) => async (path: string, input: unknown) => {
  switch (path) {
    case "/registration/preview": {
      const parsed = z.object({ app: z.string().regex(names.app.pattern), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict().safeParse(input);
      if (!parsed.success || plans === undefined) return undefined;
      if (!(await canRegister(parsed.data.app))) throw new Error("app is outside preview scope");
      const plan = await index.previewPlan(parsed.data.app, parsed.data.commit, plans);
      return Object.freeze({ admitted: false, plan });
    }
    case "/registration/policy": {
      const parsed = z.object({ app: z.string().regex(names.app.pattern) }).strict().safeParse(input);
      if (!parsed.success) return undefined;
      if (!(await canRegister(parsed.data.app))) throw new Error("app is outside registration scope");
      return index.registrationPolicy(parsed.data.app);
    }
    case "/registration/pins": {
      if (builds === undefined || !z.object({}).strict().safeParse(input).success) return undefined;
      return index.imagePins(builds);
    }
    case "/registration/build": {
      const parsed = z.object({ app: z.string().regex(names.app.pattern), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict().safeParse(input);
      if (!parsed.success || builds === undefined) return undefined;
      if (!(await canRegister(parsed.data.app))) throw new Error("app is outside build scope");
      return index.prepareBuild(parsed.data.app, parsed.data.commit, builds);
    }
    case "/registration/verified": {
      const parsed = z.object({ app: z.string().regex(names.app.pattern) }).strict().safeParse(input);
      if (!parsed.success) return undefined;
      if (!(await canRegister(parsed.data.app))) throw new Error("app is outside registration scope");
      return index.verifiedRegistration(parsed.data.app);
    }
    case "/registration/reserve": {
      const parsed = reserveRequest.safeParse(input);
      if (!parsed.success) return undefined;
      const { app, generation, runtime } = parsed.data;
      if (!(await runtimeEnabled(runtime))) throw new Error("selected registration runtime is not enabled");
      if (!(await canRegister(app))) throw new Error("app is outside initial registration scope");
      const incarnation = await index.prepareApp(app);
      const ticket = await index.reserveRegistration(app, generation, runtime);
      return Object.freeze({ incarnation, ticket });
    }
    case "/registration/submit":
    case "/registration/reconcile": {
      const parsed = ticketRequest.safeParse(input);
      if (!parsed.success) return undefined;
      const { app, generation, ticket } = parsed.data;
      if (!(await canRegister(app))) throw new Error("app is outside initial registration scope");
      return path === "/registration/submit"
        ? index.submitRegistration(app, ticket, generation)
        : index.reconcileRegistration(app, ticket, generation);
    }
    default:
      return undefined;
  }
};
