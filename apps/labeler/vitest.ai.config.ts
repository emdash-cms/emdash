import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/{ai,policy,eval,runtime}-*.test.ts"],
	},
});
