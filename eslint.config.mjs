import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

// Flat config, the same shape as the other OneJS JS packages. Correctness rules
// only: formatting is the codebase's own convention (double quotes, no
// semicolons, 4 spaces) and is left to review.
export default tseslint.config(
    {
        ignores: ["node_modules/", "**/*.d.ts"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // The .mjs files are tooling and run in Node.
        files: ["**/*.mjs"],
        languageOptions: { globals: globals.node },
    },
    {
        rules: {
            // The rules onejs-unity lints this code with, which it was
            // written under. Tests reach into IR nodes by casting, and the
            // TypeScript form's operator plumbing is untyped where it meets
            // a number or a value.
            "@typescript-eslint/no-explicit-any": "off",
            "no-empty": ["error", { allowEmptyCatch: true }],
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                varsIgnorePattern: "^_",
                caughtErrors: "none",
            }],
        },
    },
    {
        // The package runs in a browser, a worker and QuickJS, so its source
        // reaches for no host API. `npm run test:quickjs` is the proof; this is
        // the early warning, since a lint error names the line.
        files: ["src/**/*.ts"],
        ignores: ["src/**/*.test.ts"],
        rules: {
            "no-restricted-imports": ["error", {
                patterns: [{ group: ["node:*", "fs", "path", "os", "crypto"], message: "onejs-sl runs outside Node; no Node modules." }],
            }],
            "no-restricted-globals": ["error",
                ...["process", "Buffer", "TextEncoder", "TextDecoder", "performance", "structuredClone", "Intl",
                    "window", "document", "navigator", "require", "__dirname", "__filename"]
                    .map((name) => ({ name, message: "onejs-sl runs in QuickJS too, which has no such global." })),
            ],
        },
    },
)
