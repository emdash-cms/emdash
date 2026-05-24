/**
 * In-memory credential store. For tests and ephemeral CLI sessions.
 */

import type { CredentialStore, Did, PublisherSession } from "./types.js";

export class MemoryCredentialStore implements CredentialStore {
	#sessions = new Map<Did, PublisherSession>();
	#currentDid: Did | null = null;

	async current(): Promise<PublisherSession | null> {
		if (!this.#currentDid) return null;
		return this.#sessions.get(this.#currentDid) ?? null;
	}

	async get(did: Did): Promise<PublisherSession | null> {
		return this.#sessions.get(did) ?? null;
	}

	async list(): Promise<PublisherSession[]> {
		return [...this.#sessions.values()];
	}

	async put(session: PublisherSession): Promise<void> {
		this.#sessions.set(session.did, { ...session });
		if (!this.#currentDid) this.#currentDid = session.did;
	}

	async setCurrent(did: Did): Promise<void> {
		if (!this.#sessions.has(did)) {
			throw new Error(`no stored session for ${did}`);
		}
		this.#currentDid = did;
	}

	async remove(did: Did): Promise<void> {
		this.#sessions.delete(did);
		if (this.#currentDid === did) this.#currentDid = null;
	}
}
