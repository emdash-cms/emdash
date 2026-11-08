import { fork, type ChildProcess } from "node:child_process";
import {
	mkdirSync,
	renameSync,
	readFileSync,
	readdirSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import {
	getCredentials,
	listCredentialKeys,
	removeCredentials,
	resolveCredentialKey,
	saveCredentials,
} from "../../../src/cli/credentials.js";

const source = fileURLToPath(new URL("../../../src/cli/credentials.ts", import.meta.url));
const worker = fileURLToPath(new URL("./fixtures/credentials-worker.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

const credential = (token: string) => ({
	accessToken: token,
	refreshToken: `${token}-refresh`,
	expiresAt: "2099-01-01T00:00:00.000Z",
});

function setConfigHome(configHome: string): void {
	vi.stubEnv("XDG_CONFIG_HOME", configHome);
}

function readStore(configHome: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(configHome, "emdash", "auth.json"), "utf8"));
}

function waitForMessage(child: ChildProcess, expected: string, timeout = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: unknown) => message === expected && finish();
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(new Error(`child exited before ${expected}: ${code ?? signal}`));
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeout);
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function startWorker(
	configHome: string,
	releaseFile: string,
	operation: "save" | "remove",
	baseUrl: string,
	value = credential("worker"),
	pauseReads = false,
	startFile?: string,
): ChildProcess {
	return fork(
		worker,
		[
			pathToFileURL(source).href,
			operation,
			baseUrl,
			JSON.stringify(value),
			releaseFile,
			String(pauseReads),
			startFile ?? "",
		],
		{
			env: { ...process.env, XDG_CONFIG_HOME: configHome },
			silent: true,
			execArgv: [...process.execArgv, "--experimental-strip-types"],
			serialization: "advanced",
		},
	);
}

async function waitForExit(child: ChildProcess): Promise<void> {
	const stderr: Buffer[] = [];
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	if (child.exitCode !== null) {
		if (child.exitCode !== 0)
			throw new Error(`child exited ${child.exitCode}: ${Buffer.concat(stderr).toString()}`);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve();
		};
		child.once("exit", (code, signal) =>
			code === 0
				? finish()
				: finish(new Error(`child exited ${code ?? signal}: ${Buffer.concat(stderr).toString()}`)),
		);
		child.once("error", (error) => finish(error));
	});
}

async function awaitChildExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function runConcurrentCase(operation: "save" | "remove"): Promise<Record<string, unknown>> {
	const configHome = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
	temporaryDirectories.push(configHome);
	setConfigHome(configHome);
	const urlA = "https://one.example.test";
	const urlB = "https://two.example.test";
	saveCredentials(urlA, credential("initial-a"));
	saveCredentials(urlB, credential("initial-b"));

	const releaseFile = join(configHome, "release");
	const startFile = join(configHome, "start");
	const childB = startWorker(
		configHome,
		releaseFile,
		"save",
		urlB,
		credential("updated-b"),
		false,
		startFile,
	);
	const bStarting = waitForMessage(childB, "starting");
	const childA = startWorker(
		configHome,
		releaseFile,
		operation,
		urlA,
		credential("updated-a"),
		true,
	);
	const aRead = waitForMessage(childA, "read");
	try {
		await bStarting;
		await aRead;
		writeFileSync(startFile, "start");
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				childB.off("message", onMessage);
				childB.off("error", onError);
				childB.off("exit", onExit);
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, 200);
			const onMessage = (message: unknown) => {
				if (message !== "done") return;
				cleanup();
				reject(new Error("concurrent writer completed while the first writer was paused"));
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onExit = (code: number | null) => {
				cleanup();
				(code === 0 ? resolve : reject)(
					code === 0 ? undefined : new Error(`child exited ${code} before lock release`),
				);
			};
			childB.on("message", onMessage);
			childB.once("error", onError);
			childB.once("exit", onExit);
		});
		writeFileSync(releaseFile, "release");
		await Promise.all([waitForExit(childA), waitForExit(childB)]);
	} finally {
		writeFileSync(releaseFile, "release");
		childA.kill();
		childB.kill();
		await Promise.all([awaitChildExit(childA), awaitChildExit(childB)]);
	}
	return readStore(configHome);
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CLI credential store", () => {
	it("saves, updates, gets, lists, removes, and handles missing credentials", async () => {
		const configHome = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
		temporaryDirectories.push(configHome);
		setConfigHome(configHome);
		const url = "https://example.test";

		expect(getCredentials(url)).toBeNull();
		saveCredentials(url, credential("first"));
		expect(getCredentials(url)).toEqual(credential("first"));
		saveCredentials(url, credential("second"));
		expect(getCredentials(url)).toEqual(credential("second"));
		expect(listCredentialKeys()).toEqual([resolveCredentialKey(url)]);
		expect(removeCredentials(url)).toBe(true);
		expect(removeCredentials(url)).toBe(false);
		expect(getCredentials(url)).toBeNull();
	});

	it("keeps the old store and releases the lock when replacement fails", async () => {
		const configHome = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
		temporaryDirectories.push(configHome);
		setConfigHome(configHome);
		const url = "https://example.test";
		saveCredentials(url, credential("old"));
		const before = readStore(configHome);
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw new Error("replacement failed");
		});

		expect(() => saveCredentials(url, credential("new"))).toThrow("replacement failed");
		expect(readStore(configHome)).toEqual(before);
		expect(readdirSync(join(configHome, "emdash"))).toEqual(["auth.json"]);
		saveCredentials(url, credential("new"));
		expect(getCredentials(url)).toEqual(credential("new"));
		expect(readdirSync(join(configHome, "emdash"))).toEqual(["auth.json"]);
	});

	it("recovers a stale lock while preserving existing credentials", async () => {
		const configHome = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
		temporaryDirectories.push(configHome);
		setConfigHome(configHome);
		const firstUrl = "https://first.example.test";
		const secondUrl = "https://second.example.test";
		saveCredentials(firstUrl, credential("first"));
		const lockPath = join(configHome, "emdash", "auth.json.lock");
		mkdirSync(lockPath);
		const stale = new Date(Date.now() - 61_000);
		utimesSync(lockPath, stale, stale);

		saveCredentials(secondUrl, credential("second"));
		expect(readStore(configHome)).toEqual({
			[resolveCredentialKey(firstUrl)]: credential("first"),
			[resolveCredentialKey(secondUrl)]: credential("second"),
		});
	});

	it("creates owner-only config and credential files on POSIX", async () => {
		if (process.platform === "win32") return;
		const configHome = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
		temporaryDirectories.push(configHome);
		setConfigHome(configHome);
		saveCredentials("https://example.test", credential("secret"));

		expect(statSync(join(configHome, "emdash")).mode & 0o777).toBe(0o700);
		expect(statSync(join(configHome, "emdash", "auth.json")).mode & 0o777).toBe(0o600);
	});

	it.each([
		["concurrent saves", "save" as const],
		["remove versus unrelated save", "remove" as const],
	])(
		"serializes %s and preserves both writers' data",
		async (_name, operation) => {
			const store = await runConcurrentCase(operation);
			const keyA = resolveCredentialKey("https://one.example.test");
			const keyB = resolveCredentialKey("https://two.example.test");
			if (operation === "save") expect(store[keyA]).toEqual(credential("updated-a"));
			else expect(store[keyA]).toBeUndefined();
			expect(store[keyB]).toEqual(credential("updated-b"));
		},
		20_000,
	);
});
