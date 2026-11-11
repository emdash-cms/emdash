import { afterEach, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/auth/dev-bypass.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

it.each([GET, POST])(
	"rejects dev bypass in production before accessing runtime or session",
	async (handler) => {
		vi.stubEnv("DEV", false);

		const response = await handler({} as never);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});
	},
);
