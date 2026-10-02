import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function captureStream(stream: NodeJS.WriteStream) {
	const chunks: Buffer[] = [];
	const spy = vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(Buffer.from(chunk));
		return true;
	});
	return {
		spy,
		get text() {
			return Buffer.concat(chunks).toString("utf-8");
		},
	};
}

describe("citty negated flags", () => {
	let originalHome: string | undefined;
	let tempHome: string;
	let originalExit: typeof process.exit;

	beforeEach(() => {
		originalHome = process.env.HOME;
		tempHome = mkdtempSync(join(tmpdir(), "emdash-negated-args-"));
		process.env.HOME = tempHome;
		originalExit = process.exit;
		process.exit = ((code?: number | string | null | undefined) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as typeof process.exit;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		process.exit = originalExit;
		vi.restoreAllMocks();
	});

	it("publish --no-manifest skips manifest loading and fails at login, not path.resolve", async () => {
		const { publishCommand } = await import("../src/commands/publish.js");
		const out = captureStream(process.stderr);

		await expect(runCommand(publishCommand, { rawArgs: ["--no-manifest"] })).rejects.toThrow(
			"process.exit:1",
		);

		expect(out.text).toMatch(/Not logged in/);
		expect(out.text).not.toMatch(/paths\[0\]/);
	});

	it("release submit --no-wait passes wait: false to the operation", async () => {
		const submit = vi.fn().mockResolvedValue({
			id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
			packageSlug: "gallery",
			version: "1.2.3",
			state: "received",
			stateGeneration: 1,
			reasonCode: null,
			workflowId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
			expiresAt: Date.now() + 60_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			result: null,
			approvalUrl: null,
		});
		vi.doMock("../src/release-service/operations.js", () => ({
			submitDelegatedRelease: submit,
			cancelDelegatedReleaseIntent: vi.fn(),
			dryRunDelegatedRelease: vi.fn(),
			getDelegatedReleaseIntent: vi.fn(),
			interactiveReleaseUrl: vi.fn(),
		}));

		const { releaseSubmitCommand } = await import("../src/commands/release.js");
		const releaseFile = join(tempHome, "release.json");
		writeFileSync(releaseFile, "{}", "utf-8");

		await runCommand(releaseSubmitCommand, {
			rawArgs: [
				releaseFile,
				"--service-url",
				"https://release.example.com",
				"--publisher-did",
				"did:web:publisher.example.com",
				"--no-wait",
			],
		});

		expect(submit).toHaveBeenCalledOnce();
		const call = submit.mock.calls[0];
		expect(call?.[0]).toMatchObject({ wait: false });
	});
});
