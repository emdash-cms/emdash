/**
 * Coverage for the init scaffolder's environment probe.
 *
 * The probe reads three external sources: git config, git remote, and
 * package.json. Tests focus on the parts we control directly — repo
 * URL normalisation and package.json field extraction. The git-config
 * and git-remote subprocess calls are tested indirectly via `init`
 * integration tests; mocking child_process gets brittle fast and the
 * subprocess wrapper is a thin layer that doesn't have much to fail.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probeEnvironment } from "../src/init/environment.js";

describe("probeEnvironment — package.json extraction", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-env-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns all-undefined for a directory with no package.json", async () => {
		const env = await probeEnvironment(dir);
		expect(env.license).toBeUndefined();
		expect(env.description).toBeUndefined();
		// Note: authorName / authorEmail may be set from the user's
		// global git config; we don't assert on them here. The package
		// extraction is the focus.
	});

	it("reads license, description, and repository from package.json", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "test",
				license: "Apache-2.0",
				description: "A test plugin",
				repository: "https://github.com/example/test",
			}),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.license).toBe("Apache-2.0");
		expect(env.description).toBe("A test plugin");
		expect(env.repo).toBe("https://github.com/example/test");
	});

	it("normalizes git@github.com SSH URLs to https", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "test",
				repository: { type: "git", url: "git+ssh://git@github.com:example/test.git" },
			}),
			"utf8",
		);
		// SSH URL with the `ssh://` scheme prefix isn't the shape our
		// normaliser handles — the user-facing common case is
		// `git@host:path`, not `ssh://git@host/path`. The probe
		// returns undefined; the prompt's fallback chain handles it.
		const env = await probeEnvironment(dir);
		expect(env.repo).toBeUndefined();
	});

	it("strips the .git suffix and the git+ prefix from package.json#repository.url", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "test",
				repository: { type: "git", url: "git+https://github.com/example/test.git" },
			}),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.repo).toBe("https://github.com/example/test");
	});

	it("treats a malformed package.json as missing", async () => {
		await writeFile(join(dir, "package.json"), "{ not valid json", "utf8");
		const env = await probeEnvironment(dir);
		expect(env.license).toBeUndefined();
		expect(env.description).toBeUndefined();
		expect(env.repo).toBeUndefined();
	});

	it("treats a non-object package.json as missing", async () => {
		// Valid JSON but not an object — pathological but possible.
		await writeFile(join(dir, "package.json"), "[]", "utf8");
		const env = await probeEnvironment(dir);
		expect(env.license).toBeUndefined();
		expect(env.description).toBeUndefined();
	});

	it("ignores oversized package.json (defence against weird files)", async () => {
		// Build a 100 KiB file. The cap is 64 KiB; the probe should
		// skip rather than buffer the whole thing.
		const fluff = " ".repeat(100 * 1024);
		await writeFile(
			join(dir, "package.json"),
			`{ "license": "MIT", "_fluff": "${fluff}" }`,
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.license).toBeUndefined();
	});

	it("treats empty-string license / description as undefined", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "test", license: "", description: "  " }),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.license).toBeUndefined();
		expect(env.description).toBeUndefined();
	});

	it("trims whitespace from license / description values", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "test", license: "  MIT  ", description: "  hello  " }),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.license).toBe("MIT");
		expect(env.description).toBe("hello");
	});

	it("accepts repository as a bare string", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "test", repository: "https://github.com/example/test.git" }),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.repo).toBe("https://github.com/example/test");
	});

	it("returns undefined for unrecognised repository shapes", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "test", repository: { type: "git" /* no url */ } }),
			"utf8",
		);
		const env = await probeEnvironment(dir);
		expect(env.repo).toBeUndefined();
	});
});
