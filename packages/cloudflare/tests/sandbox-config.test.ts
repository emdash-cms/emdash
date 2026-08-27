import { beforeEach, describe, expect, it, vi } from "vitest";

const { readConfig } = vi.hoisted(() => ({
	readConfig: vi.fn(),
}));

vi.mock("wrangler", () => ({
	unstable_readConfig: readConfig,
}));

import { sandbox } from "../src/index.js";

describe("sandbox", () => {
	beforeEach(() => {
		readConfig.mockReset();
	});

	it("returns the Cloudflare sandbox runner when the LOADER binding is configured", () => {
		readConfig.mockReturnValue({ worker_loaders: [{ binding: "LOADER" }] });

		expect(sandbox()).toBe("@emdash-cms/cloudflare/sandbox");
		expect(readConfig).toHaveBeenCalledWith({}, { hideWarnings: true });
	});

	it("disables sandboxed plugins when Worker Loader is not configured", () => {
		readConfig.mockReturnValue({ worker_loaders: undefined });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(sandbox()).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			"[emdash] Sandboxed plugins are disabled because wrangler.jsonc has no LOADER Worker Loader binding. Worker Loader requires a Workers paid plan.",
		);

		warn.mockRestore();
	});

	it("requires the binding name used by the runtime", () => {
		readConfig.mockReturnValue({ worker_loaders: [{ binding: "OTHER_LOADER" }] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(sandbox()).toBeUndefined();

		warn.mockRestore();
	});
});
