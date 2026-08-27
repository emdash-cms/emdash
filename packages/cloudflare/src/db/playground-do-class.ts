import { Kysely, sql } from "kysely";

import { EmDashPreviewDB as PreviewDB } from "./do-class.js";
import { PreviewDODialect } from "./do-dialect.js";
import type { PreviewDBStub } from "./do-dialect.js";

const SETUP_COMPLETE_OPTION = "emdash:setup_complete";
const PLAYGROUND_INIT_ERROR = {
	code: "PLAYGROUND_INIT_ERROR",
	message: "Failed to initialize playground",
} as const;

export const PLAYGROUND_USER = {
	id: "playground-admin",
	email: "playground@emdashcms.com",
	name: "Playground User",
	role: 50,
};

type PlaygroundProgressStep = "database" | "content" | "ready";
type ReportPlaygroundProgress = (step: PlaygroundProgressStep) => void;

interface PlaygroundInitialization {
	progress: PlaygroundProgressStep[];
	listeners: Set<ReportPlaygroundProgress>;
	promise: Promise<void>;
}

export class EmDashPreviewDB extends PreviewDB {
	#initialization: PlaygroundInitialization | undefined;

	isReady(): boolean {
		try {
			const rows = this.ctx.storage.sql.exec<{ value: string }>(
				"SELECT value FROM options WHERE name = ?",
				SETUP_COMPLETE_OPTION,
			);
			for (const row of rows) {
				try {
					const value: unknown = JSON.parse(row.value);
					return value === true || value === "true";
				} catch {
					return false;
				}
			}
			return false;
		} catch (error) {
			if (error instanceof Error && error.message.includes("no such table")) return false;
			throw error;
		}
	}

	initializePlayground(ttlSeconds: number): ReadableStream<Uint8Array> {
		const existing = this.#initialization;
		if (existing) return this.createProgressStream(existing);

		if (this.isReady()) {
			return this.createProgressStream({
				progress: ["database", "content", "ready"],
				listeners: new Set(),
				promise: Promise.resolve(),
			});
		}

		const initialization: PlaygroundInitialization = {
			progress: [],
			listeners: new Set(),
			promise: Promise.resolve(),
		};
		const reportProgress: ReportPlaygroundProgress = (step) => {
			initialization.progress.push(step);
			for (const listener of initialization.listeners) listener(step);
		};

		this.#initialization = initialization;
		initialization.promise = Promise.resolve()
			.then(() => this.runInitialization(ttlSeconds, reportProgress))
			.catch((error: unknown) => {
				console.error("Playground initialization failed:", error);
				if (error instanceof Error) console.error(error.stack);
				throw error;
			})
			.finally(() => {
				if (this.#initialization === initialization) this.#initialization = undefined;
			});

		return this.createProgressStream(initialization);
	}

	private async runInitialization(
		ttlSeconds: number,
		reportProgress: ReportPlaygroundProgress,
	): Promise<void> {
		await this.scheduleCleanup(ttlSeconds);

		const localStub: PreviewDBStub = {
			query: async (statement, params) => this.query(statement, params),
		};
		const dialect = new PreviewDODialect({ getStub: () => localStub });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EmDash creates dynamic collection tables at runtime
		const db = new Kysely<any>({ dialect });

		try {
			const { runMigrations } = await import("emdash/db");
			const migrations = await runMigrations(db);
			console.log(`[playground] Migrations applied: ${migrations.applied.length}`);
			reportProgress("database");

			const { loadSeed } = await import("emdash/seed");
			const { applySeed } = await import("emdash");
			const seed = await loadSeed();
			const seedResult = await applySeed(db, seed, {
				includeContent: true,
				onConflict: "skip",
				skipMediaDownload: true,
			});
			console.log(
				`[playground] Seed applied: ${seedResult.collections.created} collections, ${seedResult.content.created} content entries`,
			);
			reportProgress("content");

			const now = new Date().toISOString();
			await sql`
				INSERT OR IGNORE INTO users (id, email, name, role, email_verified, created_at, updated_at)
				VALUES (${PLAYGROUND_USER.id}, ${PLAYGROUND_USER.email}, ${PLAYGROUND_USER.name},
				        ${PLAYGROUND_USER.role}, ${1}, ${now}, ${now})
			`.execute(db);

			try {
				await sql`
					INSERT OR REPLACE INTO options (name, value)
					VALUES (${"emdash:site_title"}, ${JSON.stringify("EmDash Playground")})
				`.execute(db);
			} catch {
				// The default title is not required for a usable playground.
			}

			await this.scheduleCleanup(ttlSeconds);
		} finally {
			await db.destroy();
		}

		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO options (name, value) VALUES (?, ?)",
			SETUP_COMPLETE_OPTION,
			JSON.stringify(true),
		);
		reportProgress("ready");
	}

	private async scheduleCleanup(ttlSeconds: number): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + ttlSeconds * 1000);
	}

	private createProgressStream(
		initialization: PlaygroundInitialization,
	): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		let disconnected = false;
		let listener: ReportPlaygroundProgress | undefined;

		return new ReadableStream({
			type: "bytes",
			async start(controller) {
				listener = (step) => {
					if (disconnected) return;
					try {
						controller.enqueue(encoder.encode(`${JSON.stringify({ step })}\n`));
					} catch {
						disconnected = true;
					}
				};
				for (const step of initialization.progress) listener(step);
				if (!disconnected) initialization.listeners.add(listener);

				try {
					await initialization.promise;
				} catch {
					if (!disconnected) {
						controller.enqueue(
							encoder.encode(`${JSON.stringify({ error: PLAYGROUND_INIT_ERROR })}\n`),
						);
					}
				} finally {
					if (listener) initialization.listeners.delete(listener);
					if (!disconnected) {
						controller.close();
						// Byte-stream close does not resolve a pending BYOB read on an empty queue.
						controller.byobRequest?.respond(0);
					}
				}
			},
			cancel() {
				disconnected = true;
				if (listener) initialization.listeners.delete(listener);
			},
		});
	}
}
