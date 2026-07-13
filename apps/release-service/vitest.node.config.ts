import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/encryption.test.ts", "test/oauth-metadata.test.ts"],
	},
});
