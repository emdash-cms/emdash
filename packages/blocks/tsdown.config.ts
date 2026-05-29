import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/server.ts", "src/builder/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "browser",
	external: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
});
