import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import functional from "eslint-plugin-functional";
import tseslint from "typescript-eslint";

// The CLI's rules (cli/eslint.config.ts), for the browser: Preact's signals change by
// assigning `.value`, and the DOM hands over its own objects, which no rule can make readonly.
export default defineConfig(
  { ignores: ["dist/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  functional.configs.externalTypeScriptRecommended,
  functional.configs.noMutations,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: "(^|/)cli/(?!src/clients/wire/contract\\.gen\\.ts$)", message: "The browser imports only the generated API contract." }] }],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "functional/immutable-data": ["error", { ignoreAccessorPattern: ["**.value", "**.current"] }],
      "functional/prefer-immutable-types": [
        "error",
        {
          enforcement: "ReadonlyDeep",
          ignoreInferredTypes: true,
          ignoreClasses: true,
          ignoreTypePattern: ["^HTML", "Event(<.*>)?$", "^EventSource$", "^Response$", "^Signal", "^ReadonlySignal", "^KeyboardEvent$", "ComponentChildren", "^VNode", "JSX"],
          returnTypes: { enforcement: "ReadonlyDeep", ignoreInferredTypes: false, ignoreClasses: true },
        },
      ],
      "functional/type-declaration-immutability": [
        "error",
        { rules: [{ identifiers: ".+", immutability: "ReadonlyDeep", comparator: "AtLeast" }], ignoreIdentifierPattern: ["Props$"] },
      ],
    },
  },
  {
    // Components return JSX (a VNode, which the rule cannot see into) and hand
    // handlers to the DOM: their inferred returns are not checked; the modules' are.
    files: ["src/**/*.tsx"],
    rules: {
      "functional/prefer-immutable-types": [
        "error",
        {
          enforcement: "ReadonlyDeep",
          ignoreInferredTypes: true,
          ignoreClasses: true,
          ignoreTypePattern: ["^HTML", "Event(<.*>)?$", "^EventSource$", "^Response$", "^Signal", "^ReadonlySignal", "^KeyboardEvent$", "ComponentChildren", "^VNode", "JSX"],
        },
      ],
    },
  },
);
