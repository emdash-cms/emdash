import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/passkey/index.ts",
		"src/totp/index.ts",
		"src/adapters/kysely.ts",
		"src/oauth/providers/github.ts",
		"src/oauth/providers/google.ts",
	],
	format: "esm",
	dts: true,
	clean: true,
});
