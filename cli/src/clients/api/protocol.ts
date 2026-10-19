import { z } from "zod";
import { options } from "../wire/schemas.ts";

export const requestBody = z.strictObject({ input: z.unknown().exactOptional(), options: options.exactOptional(), confirm: z.string().exactOptional() });
