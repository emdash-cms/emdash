import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	EnvCredentialStore,
	FileCredentialStore,
	MemoryCredentialStore,
	ReadOnlyCredentialStoreError,
	type Did,
	type PublisherSession,
} from "../src/credentials/index.js";

const session = (overrides: Partial<PublisherSession> = {}): PublisherSession => ({
	did: "did:plc:abc123" as Did,
	handle: "alice.example.com",
	pds: "https://pds.example.com",
	updatedAt: 1_700_000_000_000,
	...overrides,
});

describe("MemoryCredentialStore", () => {
	it("starts empty", async () => {
		const store = new MemoryCredentialStore();
		expect(await store.current()).toBeNull();
		expect(await store.list()).toEqual([]);
	});

	it("makes the first put the current session", async () => {
		const store = new MemoryCredentialStore();
		const s = session();
		await store.put(s);
		expect(await store.current()).toEqual(s);
	});

	it("does not change current on subsequent puts", async () => {
		const store = new MemoryCredentialStore();
		const a = session({ did: "did:plc:aaa" as Did, handle: "a.test" });
		const b = session({ did: "did:plc:bbb" as Did, handle: "b.test" });
		await store.put(a);
		await store.put(b);
		expect((await store.current())?.did).toBe(a.did);
		expect(await store.list()).toHaveLength(2);
	});

	it("setCurrent switches the active session", async () => {
		const store = new MemoryCredentialStore();
		const a = session({ did: "did:plc:aaa" as Did });
		const b = session({ did: "did:plc:bbb" as Did });
		await store.put(a);
		await store.put(b);
		await store.setCurrent(b.did);
		expect((await store.current())?.did).toBe(b.did);
	});

	it("setCurrent rejects unknown DIDs", async () => {
		const store = new MemoryCredentialStore();
		await expect(store.setCurrent("did:plc:nope" as Did)).rejects.toThrow(/no stored session/);
	});

	it("remove clears current when removing the active session", async () => {
		const store = new MemoryCredentialStore();
		const a = session();
		await store.put(a);
		await store.remove(a.did);
		expect(await store.current()).toBeNull();
		expect(await store.list()).toEqual([]);
	});

	it("isolates put-result from later mutation (defensive copy)", async () => {
		const store = new MemoryCredentialStore();
		const s = session();
		await store.put(s);
		s.handle = "mutated.test"; // mutate after put
		const stored = await store.current();
		expect(stored?.handle).toBe("alice.example.com");
	});
});

describe("FileCredentialStore", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-credentials-"));
		path = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns null current when file does not exist", async () => {
		const store = new FileCredentialStore({ path });
		expect(await store.current()).toBeNull();
	});

	it("persists across instances", async () => {
		const a = new FileCredentialStore({ path });
		await a.put(session());

		const b = new FileCredentialStore({ path });
		const current = await b.current();
		expect(current?.handle).toBe("alice.example.com");
	});

	it("writes the file with restrictive mode", async () => {
		const store = new FileCredentialStore({ path });
		await store.put(session());
		const stat = await import("node:fs/promises").then((m) => m.stat(path));
		// File mode includes type bits; mask to permission bits only.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("uses atomic rename for writes (no .tmp leftover after success)", async () => {
		const store = new FileCredentialStore({ path });
		await store.put(session());
		const fs = await import("node:fs/promises");
		await expect(fs.access(`${path}.tmp`)).rejects.toThrow();
	});

	it("preserves currentDid across remove of non-current session", async () => {
		const store = new FileCredentialStore({ path });
		const a = session({ did: "did:plc:aaa" as Did });
		const b = session({ did: "did:plc:bbb" as Did });
		await store.put(a);
		await store.put(b);
		await store.remove(b.did);
		expect((await store.current())?.did).toBe(a.did);
	});

	it("throws helpfully on a non-JSON file", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path, "this is not json");
		const store = new FileCredentialStore({ path });
		await expect(store.current()).rejects.toThrow(/not valid JSON/);
	});

	it("throws helpfully on JSON with the wrong shape", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path, JSON.stringify({ unrelated: "data" }));
		const store = new FileCredentialStore({ path });
		await expect(store.current()).rejects.toThrow(/unrecognised shape/);
	});

	it("writes a JSON envelope with version, currentDid, and sessions", async () => {
		const store = new FileCredentialStore({ path });
		await store.put(session());
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed).toMatchObject({
			version: 1,
			currentDid: "did:plc:abc123",
			sessions: {
				"did:plc:abc123": {
					did: "did:plc:abc123",
					handle: "alice.example.com",
				},
			},
		});
	});
});

describe("EnvCredentialStore", () => {
	it("returns null when env vars are unset", async () => {
		const store = new EnvCredentialStore({ env: {} });
		expect(await store.current()).toBeNull();
		expect(await store.list()).toEqual([]);
	});

	it("returns a session when all required env vars are present", async () => {
		const store = new EnvCredentialStore({
			env: {
				EMDASH_PUBLISHER_DID: "did:plc:abc",
				EMDASH_PUBLISHER_HANDLE: "alice.example.com",
				EMDASH_PUBLISHER_PDS: "https://pds.example.com",
			},
		});
		const current = await store.current();
		expect(current).toMatchObject({
			did: "did:plc:abc",
			handle: "alice.example.com",
			pds: "https://pds.example.com",
		});
	});

	it("requires all three identity env vars", async () => {
		const store = new EnvCredentialStore({
			env: {
				EMDASH_PUBLISHER_DID: "did:plc:abc",
				// missing handle and pds
			},
		});
		expect(await store.current()).toBeNull();
	});

	it("rejects malformed DIDs loudly", async () => {
		const store = new EnvCredentialStore({
			env: {
				EMDASH_PUBLISHER_DID: "not-a-did",
				EMDASH_PUBLISHER_HANDLE: "alice.example.com",
				EMDASH_PUBLISHER_PDS: "https://pds.example.com",
			},
		});
		await expect(store.current()).rejects.toThrow(/not a valid DID/);
	});

	it("throws ReadOnlyCredentialStoreError on put/setCurrent/remove", async () => {
		const store = new EnvCredentialStore({ env: {} });
		await expect(store.put(session())).rejects.toBeInstanceOf(ReadOnlyCredentialStoreError);
		await expect(store.setCurrent("did:plc:x" as Did)).rejects.toBeInstanceOf(
			ReadOnlyCredentialStoreError,
		);
		await expect(store.remove("did:plc:x" as Did)).rejects.toBeInstanceOf(
			ReadOnlyCredentialStoreError,
		);
	});

	it("get(did) only returns the env session when the DID matches", async () => {
		const store = new EnvCredentialStore({
			env: {
				EMDASH_PUBLISHER_DID: "did:plc:abc",
				EMDASH_PUBLISHER_HANDLE: "alice.example.com",
				EMDASH_PUBLISHER_PDS: "https://pds.example.com",
			},
		});
		expect(await store.get("did:plc:abc" as Did)).not.toBeNull();
		expect(await store.get("did:plc:other" as Did)).toBeNull();
	});
});
