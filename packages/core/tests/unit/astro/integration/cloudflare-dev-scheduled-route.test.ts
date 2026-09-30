import { afterEach, beforeEach, expect, it, vi } from "vitest";

const maintenance = vi.hoisted(() => ({
	runScheduledTasks: vi.fn(async () => ({ published: [] })),
}));

vi.mock("../../../../src/astro/middleware.js", () => maintenance);

import { POST } from "../../../../src/astro/routes/api/dev/scheduled-tasks.js";

beforeEach(() => {
	maintenance.runScheduledTasks.mockClear();
	vi.stubEnv("DEV", true);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

it("runs EmDash maintenance directly inside the workerd request", async () => {
	const response = await POST({} as never);

	expect(maintenance.runScheduledTasks).toHaveBeenCalledExactlyOnceWith();
	expect(response.status).toBe(204);
});

it("rejects production requests without running maintenance", async () => {
	vi.stubEnv("DEV", false);

	const response = await POST({} as never);

	expect(response.status).toBe(403);
	expect(maintenance.runScheduledTasks).not.toHaveBeenCalled();
});
