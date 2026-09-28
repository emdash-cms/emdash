import { describe, expect, test } from "vitest";

import {
	artifactsBranch,
	branchesToReap,
	fixBranch,
	playgroundPreviewUrl,
	previewInstallCommand,
	previewUrl,
	probePreviewReady,
} from "../../.flue/lib/preview.js";

describe("preview branch + URL helpers", () => {
	test("keeps the full bot/fix ref pkg.pr.new resolves by", () => {
		expect(fixBranch(42)).toBe("bot/fix-42");
		expect(artifactsBranch(42)).toBe("bot/artifacts-42");
		expect(previewUrl(42)).toBe("https://pkg.pr.new/emdash@bot/fix-42");
		expect(previewInstallCommand(42)).toBe("npm i https://pkg.pr.new/emdash@bot/fix-42");
		expect(playgroundPreviewUrl(42)).toBe("https://bot-fix-42.try.emdashcms.com/");
	});

	test("supports a staging package without probing the production preview", () => {
		expect(previewUrl(42, "owner/canary-repo/canary-package")).toBe(
			"https://pkg.pr.new/owner/canary-repo/canary-package@bot/fix-42",
		);
		expect(previewInstallCommand(42, "owner/canary-repo/canary-package")).toBe(
			"npm i https://pkg.pr.new/owner/canary-repo/canary-package@bot/fix-42",
		);
		expect(() => previewUrl(42, "https://attacker.test/x")).toThrow(/invalid preview package/);
	});
});

describe("branchesToReap", () => {
	test("spares the fix branch when an open PR references it", () => {
		expect(branchesToReap(42, true)).toEqual(["bot/artifacts-42"]);
	});

	test("deletes both branches when no PR references the fix branch", () => {
		expect(branchesToReap(42, false)).toEqual(["bot/fix-42", "bot/artifacts-42"]);
	});
});

describe("probePreviewReady", () => {
	test("resolves true on a 2xx", async () => {
		const fake = (() => Promise.resolve(new Response("", { status: 200 }))) as typeof fetch;
		await expect(probePreviewReady("https://pkg.pr.new/emdash@bot/fix-1", fake)).resolves.toBe(
			true,
		);
	});

	test("resolves false while the preview is still publishing (404)", async () => {
		const fake = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
		await expect(probePreviewReady("https://pkg.pr.new/emdash@bot/fix-1", fake)).resolves.toBe(
			false,
		);
	});

	test("resolves false on a network error rather than throwing", async () => {
		const fake = (() => Promise.reject(new Error("network"))) as typeof fetch;
		await expect(probePreviewReady("https://pkg.pr.new/emdash@bot/fix-1", fake)).resolves.toBe(
			false,
		);
	});
});
