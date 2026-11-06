/**
 * A `RoomSite` over one in-memory entry, with its `_rev`, status, author, Trash and revisions.
 * It models the kept-checkpoint contract: an empty kept save marks the draft revision kept and
 * keeps `_rev`.
 */

import type {
	CheckpointInput,
	EntryRef,
	LoadedEntry,
	OutsideValue,
	RecoveryInput,
	RoomSite,
	SaveResult,
} from "../../../src/rooms/types.js";
import type { FieldType } from "../../../src/schema/types.js";

export interface FakeRevision {
	kind: "autosave" | "kept";
	rev: string;
	actorId: string;
	editedBy: string[];
	data: Record<string, unknown>;
	slug: string | null;
}

export type ForcedResult = "CONFLICT" | "NOT_FOUND" | "REFUSED" | "reject";

export interface FakeEntryInit {
	data?: Record<string, unknown>;
	fields?: Array<{ slug: string; type: FieldType }>;
	slug?: string | null;
	status?: string;
	authorId?: string | null;
	hash?: string;
	pluginTypes?: string[];
}

export interface OutsideWrite {
	data?: Record<string, unknown>;
	slug?: string | null;
	status?: string;
	authorId?: string | null;
	trashed?: boolean;
	hash?: string;
}

export class FakeSite implements RoomSite {
	entry: LoadedEntry | null;
	revisions: FakeRevision[] = [];
	/** Every save the room sent, in order. */
	saves: CheckpointInput[] = [];
	recoveries: RecoveryInput[] = [];
	loads = 0;

	/** Results to return from the next saves, in order, before any other check. */
	forced: ForcedResult[] = [];
	/** Users the site refuses as actors. */
	forbidden = new Set<string>();
	rejectLoads = false;
	/** Loads wait for this, to hold a merge mid-load. */
	loadGate: Promise<void> | null = null;
	rejectRecoveries = false;
	/** Changes the stored values of each save, as a `content:beforeSave` hook can. */
	hook: ((data: Record<string, unknown>) => Record<string, unknown>) | null = null;
	/** Runs as each save arrives, before it applies. */
	onSave: ((input: CheckpointInput) => void) | null = null;
	/** Notified after each outside write. */
	notify: ((outside: OutsideValue[]) => Promise<void>) | null = null;

	#revs = 0;

	constructor(init: FakeEntryInit = {}) {
		this.entry = {
			rev: this.#nextRev(),
			status: init.status ?? "draft",
			authorId: init.authorId === undefined ? "author" : init.authorId,
			trashed: false,
			slug: init.slug === undefined ? "post" : init.slug,
			data: structuredClone(init.data ?? {}),
			fields: init.fields ?? [],
			hash: init.hash ?? "schema-1",
			pluginTypes: init.pluginTypes ?? [],
		};
	}

	get current(): LoadedEntry {
		if (!this.entry) throw new Error("The entry is gone");
		return this.entry;
	}

	async load(_entry: EntryRef): Promise<LoadedEntry | null> {
		this.loads++;
		await this.loadGate;
		if (this.rejectLoads) throw new Error("site unreachable");
		return this.entry && structuredClone(this.entry);
	}

	async save(_entry: EntryRef, input: CheckpointInput): Promise<SaveResult> {
		this.saves.push(structuredClone(input));
		this.onSave?.(input);
		const forced = this.forced.shift();
		if (forced === "reject") throw new Error("site unreachable");
		if (forced) return failure(forced, forced === "REFUSED" ? "VALIDATION_ERROR" : forced);
		const entry = this.entry;
		if (!entry || entry.trashed) return failure("NOT_FOUND", "NOT_FOUND");
		if (this.forbidden.has(input.actorId)) return failure("FORBIDDEN", "FORBIDDEN");
		if (input.rev !== entry.rev) return failure("CONFLICT", "CONFLICT");
		if (input.kept && input.slug === undefined && Object.keys(input.data).length === 0) {
			const draft = this.revisions.at(-1);
			if (draft) draft.kind = "kept";
			return { ok: true, rev: entry.rev, data: structuredClone(entry.data), slug: entry.slug };
		}
		let data = { ...entry.data, ...structuredClone(input.data) };
		if (this.hook) data = this.hook(data);
		entry.data = data;
		if (input.slug !== undefined) entry.slug = input.slug;
		entry.rev = this.#nextRev();
		const revision: FakeRevision = {
			kind: input.kept ? "kept" : "autosave",
			rev: entry.rev,
			actorId: input.actorId,
			editedBy: [...input.editedBy],
			data: structuredClone(data),
			slug: entry.slug,
		};
		if (!input.kept && this.revisions.at(-1)?.kind === "autosave") this.revisions.pop();
		this.revisions.push(revision);
		return { ok: true, rev: entry.rev, data: structuredClone(data), slug: entry.slug };
	}

	async saveRecovery(_entry: EntryRef, recovery: RecoveryInput): Promise<void> {
		if (this.rejectRecoveries) throw new Error("site unreachable");
		this.recoveries.push(structuredClone(recovery));
	}

	/** A write the room didn't make, which notifies the room after it commits. */
	async write(change: OutsideWrite, outside: OutsideValue[] = []): Promise<void> {
		this.change(change);
		await this.notify?.(outside);
	}

	/** Changes the entry without notifying, as a lost notification or another process does. */
	change(change: OutsideWrite): void {
		const entry = this.current;
		if (change.data) entry.data = { ...entry.data, ...structuredClone(change.data) };
		if (change.slug !== undefined) entry.slug = change.slug;
		if (change.status !== undefined) entry.status = change.status;
		if (change.authorId !== undefined) entry.authorId = change.authorId;
		if (change.trashed !== undefined) entry.trashed = change.trashed;
		if (change.hash !== undefined) entry.hash = change.hash;
		entry.rev = this.#nextRev();
	}

	/** Deletes the entry for good. */
	remove(): void {
		this.entry = null;
	}

	#nextRev(): string {
		return `rev-${++this.#revs}`;
	}
}

function failure(
	reason: "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "REFUSED",
	code: string,
): SaveResult {
	return { ok: false, reason, code, message: `The site refused the save: ${code}` };
}
