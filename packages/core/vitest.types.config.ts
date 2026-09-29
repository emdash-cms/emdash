import { defineConfig } from "vitest/config";

// Type-level tests. Typegen's product is a `.d.ts`, so what matters about it is
// what the compiler makes of it: that a selection narrows to the fields it
// named and to the target collection's own interface. Nothing here runs.
export default defineConfig({
	test: {
		include: [],
		typecheck: {
			enabled: true,
			only: true,
			include: ["tests/types/**/*.test-d.ts"],
			tsconfig: "./tsconfig.typecheck.json",
		},
	},
});
