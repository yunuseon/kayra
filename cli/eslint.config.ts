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
        { enforcement: "ReadonlyDeep", ignoreInferredTypes: true, ignoreClasses: true, ignoreTypePattern: ["^z\\.", "ZodType", "Setting"] },
      ],
      "functional/type-declaration-immutability": [
        "error",
        {
          rules: [{ identifiers: ".+", immutability: "ReadonlyDeep", comparator: "AtLeast" }],
          // Setting holds a Zod schema: immutable, but a class the rule cannot see into.
          ignoreIdentifierPattern: ["^Setting$"],
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
        },
      ],
    },
  },
  {
    // Brands are minted here, and only here: the one place `as` may appear.
    files: ["src/brand.ts", "src/deployer/brand.ts"],
    rules: { "@typescript-eslint/consistent-type-assertions": "off" },
  },
);
