import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import functional from "eslint-plugin-functional";
import tseslint from "typescript-eslint";

// Types taken as ReadonlyDeep wherever they sit: inside another (readonly Setting[], a Record of
// Operation) or in an inferred return, which ignoreTypePattern never reaches (it skips a type only where it is named).
// Setting and Operation hold Zod schemas: immutable once built, but classes the rule cannot see into.
const immutableHere = [
  { type: { from: "file", name: "Setting" }, to: "ReadonlyDeep" },
  { type: { from: "file", name: "Operation" }, to: "ReadonlyDeep" },
  // A URL's properties are writable, but functional/immutable-data refuses every write; Optique's messages hold them.
  { type: /^URL$/u, to: "ReadonlyDeep" },
  // A RegExp keeps state only in lastIndex, which only the g and y flags use; kayra's patterns (lib/names.ts) have neither.
  { type: /^RegExp$/u, to: "ReadonlyDeep" },
  // Optique's parsers keep their own parsing state (initialState); kayra only hands them to Optique.
  // command()'s and merge()'s results are intersections, matched by their names.
  { type: { from: "package", package: "@optique/core", name: ["Parser", "ParserModifiers"] }, to: "ReadonlyDeep" },
  { type: /^(FluentParser|MergeReturnType)\b/u, to: "ReadonlyDeep" },
];

export default defineConfig(
  // The compiled CLI, built for the package.
  { ignores: ["dist/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  functional.configs.externalTypeScriptRecommended,
  functional.configs.noMutations,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: { immutability: { overrides: immutableHere } },
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // A switch over an operation's name or a union's kind names every case: a new one is a lint error where it is not handled.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "suite"] }] },
      ],
      // ReadonlyDeep: Node's and Optique's types are readonly, not frozen; "Immutable" would flag every use of them.
      "functional/prefer-immutable-types": [
        "error",
        // Zod's schemas are immutable once built (every method returns a new
        // one), but its types are classes the rule cannot see into.
        // Return types are inferred (see CLAUDE.md, Code style), and checked as inferred.
        {
          enforcement: "ReadonlyDeep",
          ignoreInferredTypes: true,
          ignoreClasses: true,
          ignoreTypePattern: ["^z\\.", "ZodType"],
          returnTypes: { enforcement: "ReadonlyDeep", ignoreInferredTypes: false, ignoreClasses: true },
        },
      ],
      "functional/type-declaration-immutability": [
        "error",
        {
          rules: [{ identifiers: ".+", immutability: "ReadonlyDeep", comparator: "AtLeast" }],
        },
      ],
    },
  },
  {
    // The deployer's daemons work with Node's I/O objects (requests, responses,
    // buffers, the environment, dates, regexps): classes the rule cannot make readonly.
    files: ["src/deployer/**/*.ts", "src/server/**/*.ts"],
    // A Buffer read from a request is bytes nothing changes in place; it reaches inferred returns (Promise<Buffer | undefined>).
    settings: { immutability: { overrides: [...immutableHere, { type: /^Buffer$/u, to: "ReadonlyDeep" }] } },
    rules: {
      "functional/prefer-immutable-types": [
        "error",
        {
          enforcement: "ReadonlyDeep",
          ignoreInferredTypes: true,
          ignoreClasses: true,
          ignoreTypePattern: ["IncomingMessage", "ServerResponse", "ProcessEnv", "IncomingHttpHeaders", "Buffer", "Date", "RegExp"],
          returnTypes: { enforcement: "ReadonlyDeep", ignoreInferredTypes: false, ignoreClasses: true },
        },
      ],
    },
  },
  {
    // The local server (the API, the browser side, serve.ts) works with Node's I/O objects too (requests, responses,
    // the abort controller that stops a run; Live and Served hold them): classes the rule cannot make readonly. Its inferred returns are those
    // objects, or JSON on its way out (the wire's shapes, MCP's results): they are not checked.
    files: ["src/clients/api/**/*.ts", "src/clients/ui/**/*.ts", "src/clients/wire/**/*.ts", "src/clients/mcp/**/*.ts", "src/serve.ts"],
    rules: {
      "functional/prefer-immutable-types": [
        "error",
        {
          enforcement: "ReadonlyDeep",
          ignoreInferredTypes: true,
          ignoreClasses: true,
          ignoreTypePattern: ["IncomingMessage", "ServerResponse", "AbortController", "Buffer", "^URL$", "URLSearchParams", "^Live$", "^Served$"],
        },
      ],
      "functional/type-declaration-immutability": [
        "error",
        { rules: [{ identifiers: ".+", immutability: "ReadonlyDeep", comparator: "AtLeast" }], ignoreIdentifierPattern: ["^Live$", "^Served$"] },
      ],
    },
  },
  {
    // Tests and scripts follow the convention (no return types), but their fixtures' inferred returns are not checked.
    files: ["test/**/*.ts", "scripts/**/*.ts", "eslint.config.ts"],
    rules: {
      "functional/prefer-immutable-types": [
        "error",
        { enforcement: "ReadonlyDeep", ignoreInferredTypes: true, ignoreClasses: true, ignoreTypePattern: ["^z\\.", "ZodType"] },
      ],
    },
  },
  // Core and clients: the core knows no client, no client knows another, the
  // deployer (it runs on servers) knows neither, lib/ knows none of them. main.ts and serve.ts compose them.
  // The wire (the JSON every machine client speaks) is any client's, and knows none.
  // Shared reporting contracts carry the wire format without depending on deployer internals.
  ...(
    [
      ["src/core/**/*.ts", ["**/clients/**", "**/deployer/**", "**/server/**", "**/main.ts", "**/serve.ts"]],
      ["src/clients/cli/**/*.ts", ["**/clients/api/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"]],
      ["src/clients/api/**/*.ts", ["**/clients/cli/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"]],
      ["src/clients/ui/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"]],
      ["src/clients/mcp/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/ui/**", "**/main.ts", "**/serve.ts"]],
      ["src/clients/wire/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"]],
      ["src/contracts/**/*.ts", ["**/server/**", "**/deployer/**", "**/core/**", "**/clients/**", "**/main.ts", "**/serve.ts", "**/lib/schema.ts", "**/lib/yaml.ts"]],
      // The deployer's image installs no packages: of lib/, only what imports none.
      ["src/deployer/**/*.ts", ["**/core/**", "**/clients/**", "**/main.ts", "**/serve.ts", "**/lib/schema.ts", "**/lib/yaml.ts"]],
      // lib/ is what any TypeScript project could use: it knows nothing of kayra.
      ["src/lib/**/*.ts", ["**/core/**", "**/clients/**", "**/deployer/**", "**/main.ts", "**/serve.ts"]],
    ] as const
  ).map(([files, forbidden]) => ({
    files: [files],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: [...forbidden], message: "Core and clients stay apart: see CLAUDE.md, Core and clients." },
          ],
        },
      ] satisfies ["error", unknown],
    },
  })),
  {
    // Platform code consumes public facts and commands, never coordinator internals.
    files: ["src/server/platform/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/deployer/**", "**/deployment/**", "**/core/**", "**/clients/**"], message: "Platform code must use published contracts and commands, not component internals." }] }],
    },
  },
  {
    // Builder code does not choose or invoke workload runtime adapters.
    files: ["src/server/builder/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/runtime/**", "**/deployer/runs/**", "**/deployer/build/compose.ts", "**/deployer/build/compose.js"], message: "Builders produce bundles; workload runtime operations belong to adapters." }] }],
      "no-restricted-syntax": ["error", { selector: "ImportExpression", message: "Builders must use statically checked imports." }],
    },
  },
  {
    // Runtime adapters consume normalized inputs, not policy or other components' internals.
    files: ["src/server/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/deployer/**", "**/deployment/**", "**/platform/**", "**/core/**", "**/clients/**"], message: "Runtime adapters must use normalized inputs rather than other components' internals." }] }],
    },
  },
  {
    // Runtime effects belong behind coordinator ports. These lint rules are a
    // maintenance guardrail, not a sandbox for untrusted JavaScript.
    files: ["src/server/deployment/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: ["child_process", "cluster", "module", "http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "worker_threads"].flatMap((name) => [
          { name, message: "Use a typed runtime port." },
          { name: `node:${name}`, message: "Use a typed runtime port." },
        ]),
        patterns: [{ group: ["**/deployer/**", "**/builder/**", "**/platform/**", "**/runtime/**", "**/core/**", "**/clients/**"], message: "Use a typed port or shared contract rather than component internals." }],
      }],
      "no-restricted-syntax": ["error",
        { selector: "ImportExpression", message: "Coordinator imports must be statically checked." },
        { selector: "MemberExpression[object.name='globalThis'][property.name=/^(fetch|require)$/]", message: "Use a typed port and statically checked imports." },
        { selector: "MemberExpression[object.name='globalThis'][property.value=/^(fetch|require)$/]", message: "Use a typed port and statically checked imports." },
      ],
      "no-restricted-globals": ["error", { name: "require", message: "Use statically checked imports." }, { name: "fetch", message: "Use a typed port for network effects." }],
      "no-restricted-properties": ["error", ...["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "mainModule"].map((property) => ({
        object: "process", property, message: "Use a typed port and statically checked imports.",
      }))],
    },
  },
  {
    // Brands are minted here, and only here: the one place `as` may appear.
    files: ["src/lib/brand.ts", "src/core/fleet/brand.ts", "src/deployer/brand.ts"],
    rules: { "@typescript-eslint/consistent-type-assertions": "off" },
  },
);
