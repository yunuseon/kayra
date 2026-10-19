import type { AbsolutePath, Host, Port } from "../fleet/brand.ts";
import type { Result } from "../../lib/result.ts";
import type { Reach } from "./model.ts";

/** OpenTofu's state, as status reads it. */
export type Tofu = {
  /** The resources in a terraform/ directory's state, or why it could not be read. */
  readonly state: (dir: AbsolutePath) => Promise<Result<readonly string[], string>>;
  readonly output: (dir: AbsolutePath, name: string) => Promise<string | undefined>;
};

/** The network, as status probes it. */
export type Network = {
  /** A TCP connection to a port. */
  readonly connect: (host: Host, port: Port) => Promise<Reach>;
  readonly get: (url: string) => Promise<Reach>;
};
