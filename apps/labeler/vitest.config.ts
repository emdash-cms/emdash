import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["test/{ai,eval,policy,runtime}-*.test.ts", "test/ui/**"],
	},
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					LABEL_SIGNING_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
					LABEL_SIGNING_PUBLIC_KEY: "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ",
					OPERATOR_ACCESS_CONFIG: JSON.stringify({
						teamDomain: "https://test.cloudflareaccess.com",
						audience: "test-audience",
						admins: [],
						reviewers: [],
					}),
					RECONCILIATION_TOKEN: "test-reconciliation-token",
				},
				serviceBindings: {
					AGGREGATOR_RECONCILIATION: async (request) => {
						if (request.headers.get("authorization") !== "Bearer test-reconciliation-token") {
							return new Response("unauthorized", { status: 401 });
						}
						const url = new URL(request.url);
						if (url.pathname.endsWith("/subjects")) return Response.json({ items: [] });
						if (url.pathname.endsWith("/current")) return Response.json({ current: true });
						return new Response("not found", { status: 404 });
					},
				},
			},
		}),
	],
});
