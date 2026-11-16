import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov", "html"],
      include: ["src/**"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "tests/**",
        // The stdio entry shim runs only as a spawned subprocess: it installs
        // `serveStdio` and signal handlers, so in-process coverage can never
        // execute it. `tests/stdio.test.ts` exercises it against `dist/`.
        "src/index.ts",
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
