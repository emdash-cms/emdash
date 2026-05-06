/**
 * Filesystem-backed credential store.
 *
 * Persists publisher sessions to `~/.emdash/credentials.json` with restrictive
 * file mode (0600) so other local users on a shared box can't read them.
 *
 * The file format is intentionally a flat versioned envelope -- `{ version,
 * currentDid, sessions }` -- so we can add fields without breaking older CLI
 * builds. Unknown fields are preserved on round-trip.
 *
 * Atomicity: writes go to a temp file (`credentials.json.tmp`) first and then
 * `rename()` over the target. `rename` is atomic on POSIX, so a torn write
 * during a crash leaves the previous file intact.
 *
 * Concurrency: this store does not implement file locking. Concurrent writes
 * from two CLI invocations of the same publisher could race, with the last
 * writer winning. That's acceptable for an interactive tool; CI should use
 * `EnvCredentialStore` instead.
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CredentialStore, Did, PublisherSession } from "./types.js";

/** Current on-disk schema version. Bump only on breaking format changes. */
const FILE_VERSION = 1;

interface FileEnvelope {
	version: number;
	currentDid: Did | null;
	sessions: Record<string, PublisherSession>;
}

export interface FileCredentialStoreOptions {
	/**
	 * Path to the credentials file. Defaults to `~/.emdash/credentials.json`.
	 * Tests typically pass a temp-dir path here.
	 */
	path?: string;
}

const DEFAULT_PATH = join(homedir(), ".emdash", "credentials.json");

export class FileCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(options: FileCredentialStoreOptions = {}) {
		this.path = options.path ?? DEFAULT_PATH;
	}

	async current(): Promise<PublisherSession | null> {
		const envelope = await this.#read();
		if (!envelope.currentDid) return null;
		return envelope.sessions[envelope.currentDid] ?? null;
	}

	async get(did: Did): Promise<PublisherSession | null> {
		const envelope = await this.#read();
		return envelope.sessions[did] ?? null;
	}

	async list(): Promise<PublisherSession[]> {
		const envelope = await this.#read();
		return Object.values(envelope.sessions);
	}

	async put(session: PublisherSession): Promise<void> {
		const envelope = await this.#read();
		envelope.sessions[session.did] = { ...session };
		if (!envelope.currentDid) envelope.currentDid = session.did;
		await this.#write(envelope);
	}

	async setCurrent(did: Did): Promise<void> {
		const envelope = await this.#read();
		if (!envelope.sessions[did]) {
			throw new Error(`no stored session for ${did}`);
		}
		envelope.currentDid = did;
		await this.#write(envelope);
	}

	async remove(did: Did): Promise<void> {
		const envelope = await this.#read();
		delete envelope.sessions[did];
		if (envelope.currentDid === did) envelope.currentDid = null;
		await this.#write(envelope);
	}

	async #read(): Promise<FileEnvelope> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if (isErrnoException(error) && error.code === "ENOENT") {
				return { version: FILE_VERSION, currentDid: null, sessions: {} };
			}
			throw error;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`credential store at ${this.path} is not valid JSON; refusing to overwrite. delete it manually if it is corrupted.`,
				{ cause: error },
			);
		}

		if (!isFileEnvelope(parsed)) {
			throw new Error(
				`credential store at ${this.path} has an unrecognised shape; refusing to overwrite.`,
			);
		}

		// Future: branch on parsed.version for migrations. For v1 we accept it as-is.
		return {
			version: FILE_VERSION,
			currentDid: parsed.currentDid,
			sessions: { ...parsed.sessions },
		};
	}

	async #write(envelope: FileEnvelope): Promise<void> {
		const dir = dirname(this.path);
		await mkdir(dir, { recursive: true, mode: 0o700 });

		const tmp = `${this.path}.tmp`;
		const body = `${JSON.stringify(envelope, null, 2)}\n`;

		try {
			// `flush: true` (Node 21.1+) fsyncs the file content before close,
			// so a power loss between the rename and a crash can't surface an
			// empty inode pointing at unwritten data. Atomic rename alone is
			// torn-write safe but not durable.
			await writeFile(tmp, body, { mode: 0o600, flush: true });
			await rename(tmp, this.path);
			// fsync the directory after the rename so the rename itself is
			// durable across power loss. POSIX file fsync persists the inode
			// data but not the directory entry; only directory fsync persists
			// the rename. Best-effort -- some filesystems (e.g. FAT, Windows)
			// reject open(O_RDONLY) on a directory.
			await fsyncDir(dir).catch(() => {});
		} catch (error) {
			// Best-effort cleanup of the temp file if rename failed mid-write.
			await unlink(tmp).catch(() => {});
			throw error;
		}
	}
}

/**
 * fsync a directory so a rename inside it is durable. Node lacks a direct
 * `fs.fsyncDir`; the workaround is `open(dir, 'r')` then `handle.sync()`.
 */
async function fsyncDir(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

function isFileEnvelope(input: unknown): input is FileEnvelope {
	if (!input || typeof input !== "object") return false;
	if (!("version" in input) || typeof input.version !== "number") return false;
	if (!("currentDid" in input)) return false;
	if (input.currentDid !== null && typeof input.currentDid !== "string") return false;
	if (!("sessions" in input) || !input.sessions || typeof input.sessions !== "object") {
		return false;
	}
	return true;
}
