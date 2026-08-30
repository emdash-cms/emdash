import type { Database } from "emdash";
import {
	applySeed,
	handleMediaUsageActivationAdvance,
	handleMediaUsageProgress,
	handleMediaUsageRepair,
	OptionsRepository,
} from "emdash";
import type { Storage } from "emdash";
import { runMigrations } from "emdash/db";
import type { SeedFile } from "emdash/seed";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import { PLAYGROUND_MEDIA_ASSETS, type PlaygroundMediaAsset } from "./playground-assets-storage.js";

const PLAYGROUND_USER_ID = "playground-admin";
const PLAYGROUND_USER_EMAIL = "playground@emdashcms.com";
const PLAYGROUND_USER_NAME = "Playground User";
const PLAYGROUND_USER_ROLE = 50;
const INITIALIZATION_LOCKS_KEY = Symbol.for("emdash:playground-initialization-locks");
const globalStore = globalThis as Record<symbol, unknown>;
interface PlaygroundInitializationLock {
	owned: boolean;
}
const initializationLocks =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton shared across duplicated SSR chunks
	(globalStore[INITIALIZATION_LOCKS_KEY] as
		| Map<string, PlaygroundInitializationLock>
		| undefined) ?? new Map();
globalStore[INITIALIZATION_LOCKS_KEY] = initializationLocks;
const INITIALIZATION_MAX_WAIT_MS = 75_000;
const INITIALIZATION_POLL_MS = 50;

export async function runPlaygroundInitialization(
	key: string,
	isReady: () => boolean,
	initialize: () => Promise<void>,
	anchor: (promise: Promise<void>) => void,
): Promise<void> {
	const lock = initializationLocks.get(key) ?? { owned: false };
	initializationLocks.set(key, lock);
	const waitStartedAt = Date.now();

	for (;;) {
		if (isReady()) return;
		if (!lock.owned) {
			lock.owned = true;
			const promise = Promise.resolve()
				.then(initialize)
				.finally(() => {
					lock.owned = false;
				});
			anchor(promise.then(undefined, () => undefined));
			await promise;
			return;
		}

		if (Date.now() - waitStartedAt > INITIALIZATION_MAX_WAIT_MS) {
			throw new Error("Timed out waiting for Playground initialization");
		}
		await new Promise((resolve) => setTimeout(resolve, INITIALIZATION_POLL_MS));
	}
}

export async function initializePlayground(
	db: Kysely<Database>,
	seed: SeedFile,
	storage: Storage,
): Promise<void> {
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
	if (
		!activation.success ||
		activation.data.outcome !== "active" ||
		activation.data.activation.state !== "active"
	) {
		throw new Error("Media Usage activation did not become active");
	}

	assertPlaygroundSeed(seed);

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

	await preparePlaygroundMedia(db, storage, now);

	await applySeed(db, seed, {
		includeContent: true,
		onConflict: "update",
	});

	await assertStoredSeedMedia(db);
	const repair = await handleMediaUsageRepair(db, { scope: "all" });
	const expectedCollections = ["pages", "posts"];
	if (
		!repair.success ||
		repair.data.status !== "complete" ||
		repair.data.failedSourceCount !== 0 ||
		repair.data.skippedSourceCount !== 0 ||
		repair.data.collections.length !== expectedCollections.length ||
		repair.data.collections.some(
			(collection, index) =>
				collection.collection !== expectedCollections[index] || collection.status !== "complete",
		)
	) {
		throw new Error("Media Usage did not reach Ready");
	}
	const progress = await handleMediaUsageProgress(db);
	if (
		!progress.success ||
		progress.data.status !== "ready" ||
		progress.data.readyCollections !== 2 ||
		progress.data.totalCollections !== 2
	) {
		throw new Error("Media Usage did not reach Ready");
	}
	await options.set("emdash:site_title", "EmDash Playground");
	await options.set("emdash:setup_complete", true);
}

async function preparePlaygroundMedia(
	db: Kysely<Database>,
	storage: Storage,
	createdAt: string,
): Promise<void> {
	for (const asset of PLAYGROUND_MEDIA_ASSETS) {
		const download = await storage.download(asset.storageKey);
		try {
			if (download.contentType !== asset.mimeType || download.size !== asset.size) {
				throw new Error(`Bundled media metadata does not match ${asset.storageKey}`);
			}
		} finally {
			await download.body.cancel();
		}

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
				status: "ready",
				created_at: createdAt,
				author_id: PLAYGROUND_USER_ID,
				folder_id: null,
			})
			.onConflict((conflict) => conflict.column("id").doNothing())
			.execute();
	}

	const rows = await db.selectFrom("media").selectAll().execute();
	if (rows.length !== PLAYGROUND_MEDIA_ASSETS.length) {
		throw new Error("Playground media row count does not match the bundled manifest");
	}
	for (const asset of PLAYGROUND_MEDIA_ASSETS) {
		const row = rows.find(({ id }) => id === asset.id);
		if (
			!row ||
			row.filename !== asset.filename ||
			row.mime_type !== asset.mimeType ||
			row.size !== asset.size ||
			row.width !== asset.width ||
			row.height !== asset.height ||
			row.alt !== asset.alt ||
			row.storage_key !== asset.storageKey ||
			row.status !== "ready" ||
			row.author_id !== PLAYGROUND_USER_ID ||
			[
				row.focal_x,
				row.focal_y,
				row.caption,
				row.content_hash,
				row.blurhash,
				row.dominant_color,
				row.folder_id,
			].some((value) => value !== null)
		) {
			throw new Error(`Playground media row does not match ${asset.storageKey}`);
		}
	}
}

function assertPlaygroundSeed(seed: SeedFile): void {
	const posts = seed.content?.posts;
	const pages = seed.content?.pages;
	if (posts?.length !== 8 || pages?.length !== 1) {
		throw new Error("Playground seed must contain eight posts and one page");
	}

	const assetsByPost = new Map(PLAYGROUND_MEDIA_ASSETS.map((asset) => [asset.postSlug, asset]));
	let referencedAssets = 0;
	for (const post of posts) {
		const asset = assetsByPost.get(post.slug ?? "");
		const image = post.data.featured_image;
		if (!asset) {
			if (image != null) throw new Error(`Unexpected Playground media reference: ${post.slug}`);
			continue;
		}
		assertMediaValue(image, asset);
		referencedAssets++;
	}
	if (referencedAssets !== PLAYGROUND_MEDIA_ASSETS.length) {
		throw new Error("Playground seed does not reference every bundled media item");
	}
}

async function assertStoredSeedMedia(db: Kysely<Database>): Promise<void> {
	const result = await sql<{ slug: string; featured_image: string }>`
		SELECT slug, featured_image
		FROM ec_posts
		WHERE locale = ${"en"} AND featured_image IS NOT NULL
	`.execute(db);
	if (result.rows.length !== PLAYGROUND_MEDIA_ASSETS.length) {
		throw new Error("Stored Playground posts do not reference seven media items");
	}
	const assetsByPost = new Map(PLAYGROUND_MEDIA_ASSETS.map((asset) => [asset.postSlug, asset]));
	for (const row of result.rows) {
		const asset = assetsByPost.get(row.slug);
		if (!asset) throw new Error(`Unexpected stored Playground post: ${row.slug}`);
		assertMediaValue(JSON.parse(row.featured_image), asset);
	}
}

function assertMediaValue(value: unknown, asset: PlaygroundMediaAsset): void {
	if (!isRecord(value) || !isRecord(value.meta)) {
		throw new Error(`Invalid Playground media value for ${asset.postSlug}`);
	}
	if (
		value.provider !== "local" ||
		value.id !== asset.id ||
		value.filename !== asset.filename ||
		value.alt !== asset.alt ||
		value.mimeType !== asset.mimeType ||
		value.width !== asset.width ||
		value.height !== asset.height ||
		value.meta.storageKey !== asset.storageKey
	) {
		throw new Error(`Playground media value does not match ${asset.postSlug}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
