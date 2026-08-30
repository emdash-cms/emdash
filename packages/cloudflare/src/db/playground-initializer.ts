import type { Database } from "emdash";
import {
	applySeed,
	handleMediaUsageActivationAdvance,
	handleMediaUsageProgress,
	handleMediaUsageRepair,
	OptionsRepository,
} from "emdash";
import { runMigrations } from "emdash/db";
import type { SeedFile } from "emdash/seed";
import type { Kysely } from "kysely";

import { PLAYGROUND_MEDIA_ASSETS } from "./playground-assets-storage.js";

const PLAYGROUND_USER_ID = "playground-admin";
const PLAYGROUND_USER_EMAIL = "playground@emdashcms.com";
const PLAYGROUND_USER_NAME = "Playground User";
const PLAYGROUND_USER_ROLE = 50;
export async function initializePlayground(db: Kysely<Database>, seed: SeedFile): Promise<void> {
	const options = new OptionsRepository(db);
	try {
		if ((await options.get<boolean>("emdash:setup_complete")) === true) return;
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("no such table: options")) {
			throw error;
		}
	}

	await runMigrations(db);
	const activation = await handleMediaUsageActivationAdvance(db, { writersDrained: true });
	if (!activation.success || activation.data.activation.state !== "active") {
		throw new Error("Media Usage activation did not become active");
	}

	const now = new Date().toISOString();
	await db
		.insertInto("users")
		.values({
			id: PLAYGROUND_USER_ID,
			email: PLAYGROUND_USER_EMAIL,
			name: PLAYGROUND_USER_NAME,
			role: PLAYGROUND_USER_ROLE,
			email_verified: 1,
			created_at: now,
			updated_at: now,
		})
		.onConflict((conflict) => conflict.column("id").doNothing())
		.execute();

	for (const asset of PLAYGROUND_MEDIA_ASSETS) {
		await db
			.insertInto("media")
			.values({
				id: asset.id,
				filename: asset.filename,
				mime_type: asset.mimeType,
				size: asset.size,
				width: asset.width,
				height: asset.height,
				focal_x: null,
				focal_y: null,
				alt: asset.alt,
				caption: null,
				storage_key: asset.storageKey,
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				status: "ready" as const,
				created_at: now,
				author_id: PLAYGROUND_USER_ID,
				folder_id: null,
			})
			.onConflict((conflict) => conflict.column("id").doNothing())
			.execute();
	}

	await applySeed(db, seed, {
		includeContent: true,
		onConflict: "update",
	});

	const repair = await handleMediaUsageRepair(db, { scope: "all" });
	if (!repair.success || repair.data.status !== "complete") {
		throw new Error("Media Usage did not reach Ready");
	}
	const progress = await handleMediaUsageProgress(db);
	if (!progress.success || progress.data.status !== "ready") {
		throw new Error("Media Usage did not reach Ready");
	}
	await options.set("emdash:site_title", "EmDash Playground");
	await options.set("emdash:setup_complete", true);
}
