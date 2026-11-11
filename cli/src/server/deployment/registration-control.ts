import { z } from "zod";
import { names } from "../../lib/names.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { registrationGenerationId } from "./lifecycle-envelope.ts";

const request = z.object({
  app: z.string().regex(names.app.pattern),
  generation: registrationGenerationId,
}).strict();
const ticketRequest = request.extend({ ticket: z.string().max(80) });

type AppIndex = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>,
  "verifiedRegistration" | "prepareApp" | "reserveRegistration" | "submitRegistration" | "reconcileRegistration">>;

export const registrationControl = (index: AppIndex, canRegister: (app: string) => Promise<boolean>) => async (path: string, input: unknown) => {
  switch (path) {
    case "/registration/verified": {
      const parsed = z.object({ app: z.string().regex(names.app.pattern) }).strict().safeParse(input);
      if (!parsed.success) return undefined;
      if (!(await canRegister(parsed.data.app))) throw new Error("app is outside registration scope");
      return index.verifiedRegistration(parsed.data.app);
    }
    case "/registration/reserve": {
      const parsed = request.safeParse(input);
      if (!parsed.success) return undefined;
      const { app, generation } = parsed.data;
      if (!(await canRegister(app))) throw new Error("app is outside initial registration scope");
      const incarnation = await index.prepareApp(app);
      const ticket = await index.reserveRegistration(app, generation);
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
