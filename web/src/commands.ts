import type { InputOf, OperationName } from "../../cli/src/clients/wire/contract.gen.ts";

export type CommandInput = { readonly [N in OperationName]: { readonly name: N } & (InputOf<N> extends Readonly<Record<string, never>> ? object : InputOf<N>) }[OperationName];
