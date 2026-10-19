import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import functional from "eslint-plugin-functional";
import tseslint from "typescript-eslint";

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
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
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
          ignoreTypePattern: ["^z\\.", "ZodType", "Setting", "^Operation$"],
          returnTypes: { enforcement: "ReadonlyDeep", ignoreInferredTypes: false, ignoreClasses: true },
        },
      ],
      "functional/type-declaration-immutability": [
        "error",
        {
          rules: [{ identifiers: ".+", immutability: "ReadonlyDeep", comparator: "AtLeast" }],
          // Setting holds a Zod schema: immutable, but a class the rule cannot see into.
          ignoreIdentifierPattern: ["^Setting$", "^Operation$"],
        },
      ],
    },
  },
  {
    // The deployer's daemons work with Node's I/O objects (requests, responses,
    // buffers, the environment, dates, regexps): classes the rule cannot make readonly.
    files: ["src/deployer/**/*.ts"],
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
          ignoreTypePattern: ["IncomingMessage", "ServerResponse", "AbortController", "Buffer", "^URL$", "URLSearchParams", "^Live$", "^Served$", "^Operation$"],
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
        { enforcement: "ReadonlyDeep", ignoreInferredTypes: true, ignoreClasses: true, ignoreTypePattern: ["^z\\.", "ZodType", "Setting", "^Operation$"] },
      ],
    },
  },
  // Core and clients: the core knows no client, no client knows another, the
  // deployer (it runs on servers) knows neither. main.ts and serve.ts compose them.
  // The wire (the JSON every machine client speaks) is any client's, and knows none.
  // The core may name the deployer's answers as types: they are ctl's wire format.
  ...(
    [
      ["src/core/**/*.ts", ["**/clients/**", "**/main.ts", "**/serve.ts"], true],
      ["src/clients/cli/**/*.ts", ["**/clients/api/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"], false],
      ["src/clients/api/**/*.ts", ["**/clients/cli/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"], false],
      ["src/clients/ui/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"], false],
      ["src/clients/mcp/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/ui/**", "**/main.ts", "**/serve.ts"], false],
      ["src/clients/wire/**/*.ts", ["**/clients/cli/**", "**/clients/api/**", "**/clients/ui/**", "**/clients/mcp/**", "**/main.ts", "**/serve.ts"], false],
      ["src/deployer/**/*.ts", ["**/core/**", "**/clients/**", "**/main.ts", "**/serve.ts"], false],
    ] as const
  ).map(([files, forbidden, deployerTypes]) => ({
    files: [files],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: [...forbidden], message: "Core and clients stay apart: see CLAUDE.md, Core and clients." },
            ...(deployerTypes ? [{ group: ["**/deployer/**"], allowTypeImports: true, message: "The core runs no deployer code; its answers' types are fine." }] : []),
          ],
        },
      ] satisfies ["error", unknown],
    },
  })),
  {
    // Brands are minted here, and only here: the one place `as` may appear.
    files: ["src/core/fleet/brand.ts", "src/deployer/brand.ts"],
    rules: { "@typescript-eslint/consistent-type-assertions": "off" },
  },
);
