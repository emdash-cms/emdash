import { afterEach, beforeEach, expect, it } from "vitest";

import { sha256Hex } from "../../../../src/transfer/format/digest.js";
import { KIND_REFERENCES, type SitePackageRecord } from "../../../../src/transfer/format/kinds.js";
import { MANIFEST_PATH } from "../../../../src/transfer/format/paths.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../../utils/transfer/origin-site.js";
import { packageFiles, packageRecords, runExport } from "./helpers.js";

const decoder = new TextDecoder();

function byId(records: SitePackageRecord[] | undefined): Map<string, SitePackageRecord> {
	return new Map((records ?? []).map((record) => [record.id, record]));
}

describeEachDialect("site export", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let site: OriginSite;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		site = await buildOriginSite(ctx.db, storage);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("exports a package that never contains credentials, secrets, or storage keys", async () => {
		const { result, reader } = await runExport(ctx.db, storage);
		expect({
			outcome: result.outcome,
			error: result.operation.errorCode,
			detail: result.operation.errorDetail,
		}).toEqual({
			outcome: "complete",
			error: null,
			detail: null,
		});
		expect(result.operation.state).toBe("complete");

		const files = await packageFiles(reader);
		const text = Array.from(files.values(), (bytes) => decoder.decode(bytes)).join("\n");
		for (const forbidden of site.forbidden) {
			expect(text, forbidden).not.toContain(forbidden);
		}
		expect(result.operation.packageDigest).toBe(await reader.digest());
	});

	it("exports every kind with principals, drops, and declared transformations", async () => {
		const { reader } = await runExport(ctx.db, storage);
		const manifest = await reader.manifest();
		const records = await packageRecords(reader);
		const ids = site.ids;

		expect(
			Object.fromEntries(Object.entries(manifest.records).map(([k, v]) => [k, v.count])),
		).toEqual({
			principal: 2,
			block_type: 2,
			block_type_version: 3,
			collection: 2,
			field: 10,
			taxonomy_def: 3,
			relation: 1,
			byline_field: 2,
			media_folder: 1,
			media: 4,
			term: 4,
			byline: 3,
			byline_field_value: 1,
			byline_field_group_value: 1,
			revision: 3,
			entry: 6,
			content_term: 3,
			content_byline: 2,
			content_reference: 1,
			seo: 1,
			menu: 2,
			menu_item: 3,
			widget_area: 1,
			widget: 2,
			section: 1,
			redirect: 1,
			comment: 3,
			comment_reaction: 1,
			setting: 5,
		});

		expect(records.get("principal")).toEqual([
			{ kind: "principal", id: ids.alice, displayName: "Alice Author", email: "alice@example.com" },
			{ kind: "principal", id: ids.bob, displayName: "Bob", email: "bob@example.com" },
		]);

		const media = byId(records.get("media"));
		expect(media.has(ids.pendingMedia)).toBe(false);
		for (const item of site.media.filter((m) => m.status === "ready")) {
			const record = media.get(item.id);
			expect(record?.kind === "media" && record.blob).toBe(await sha256Hex(item.bytes));
		}
		expect(manifest.media).toEqual({ count: 3, totalBytes: 11 + 13 + 6 });

		const transformations = Object.fromEntries(
			manifest.transformations.map((t) => [`${t.code}:${t.kind}`, t.count]),
		);
		expect(transformations["media_not_ready_dropped:media"]).toBe(1);
		expect(transformations["soft_orphan_dropped:content_term"]).toBe(1);
		expect(transformations["media_url_relativized:entry"]).toBe(1);
		expect(transformations["media_url_relativized:revision"]).toBe(1);

		const hello = byId(records.get("entry")).get(ids.hello);
		expect(hello?.kind).toBe("entry");
		if (hello?.kind !== "entry") return;
		const body = JSON.stringify(hello.fields.content);
		expect(body).toContain(`"href":"/_emdash/api/media/file/emdash-media:${ids.inlineMedia}"`);
		expect(body).not.toContain("origin.example");
		const featured = hello.fields.featured_image;
		expect(typeof featured).toBe("string");
		expect(JSON.parse(typeof featured === "string" ? featured : "null")).toMatchObject({
			id: ids.heroMedia,
			meta: { storageKey: `emdash-media:${ids.heroMedia}` },
		});
		expect(hello.fields.blocks).toEqual([
			expect.objectContaining({
				_type: "callout",
				_version: 2,
				image: expect.objectContaining({
					meta: { storageKey: `emdash-media:${ids.inlineMedia}` },
				}),
			}),
			expect.objectContaining({ _type: "callout", _version: 1 }),
			expect.objectContaining({ _type: "quote", _version: 1 }),
		]);

		const blockTypes = byId(records.get("block_type"));
		expect(blockTypes.get(ids.calloutBlock)).toEqual({
			kind: "block_type",
			id: ids.calloutBlock,
			slug: "callout",
			label: "Callout",
			description: "A highlighted note",
			icon: "megaphone",
			category: "Text",
			currentVersion: 2,
			source: "user",
			createdAt: expect.any(String),
			updatedAt: expect.any(String),
		});
		const versions = records.get("block_type_version") ?? [];
		expect(
			versions.map((record) =>
				record.kind === "block_type_version"
					? [record.blockTypeId, record.version, Object.hasOwn(record, "fingerprint")]
					: null,
			),
		).toEqual(
			expect.arrayContaining([
				[ids.calloutBlock, 1, false],
				[ids.calloutBlock, 2, false],
				[ids.quoteBlock, 1, false],
			]),
		);

		const bonjour = byId(records.get("entry")).get(ids.bonjour);
		expect(bonjour?.kind === "entry" && bonjour.fields.featured_image).toBe(
			`emdash-media:${ids.heroMedia}`,
		);

		const settings = byId(records.get("setting"));
		expect([...settings.keys()].toSorted()).toEqual([
			"emdash:site_title",
			"site:logo",
			"site:seo",
			"site:tagline",
			"site:title",
		]);

		const comments = records.get("comment") ?? [];
		expect(comments.map((c) => c.id)).toEqual([
			ids.rootComment,
			ids.pendingComment,
			ids.replyComment,
		]);
		expect(comments.find((c) => c.id === ids.pendingComment)).toMatchObject({
			body: "Is emdash-media::01ABC a bug? Also emdash-media:::x and a trailing emdash-media::",
			status: "pending",
		});
		for (const comment of comments) {
			expect(Object.keys(comment)).not.toContain("ipHash");
			expect(Object.keys(comment)).not.toContain("userAgent");
		}
		expect(records.get("comment_reaction")?.[0]).toEqual({
			kind: "comment_reaction",
			id: expect.any(String),
			commentId: ids.rootComment,
			reaction: "like",
			createdAt: expect.any(String),
		});

		const redirect = records.get("redirect")?.[0];
		expect(redirect && Object.keys(redirect)).not.toContain("hits");

		expect(manifest.locales).toEqual({ default: "en", used: ["en", "fr"] });
		expect(manifest.features).toEqual(
			expect.arrayContaining(["comments", "i18n", "media", "principals", "trash"]),
		);

		// Every hard reference in the package resolves inside it.
		const index = new Map<string, Set<string>>();
		for (const [kind, list] of records) {
			const keys = new Set<string>();
			for (const record of list) {
				keys.add(record.id);
				const group = Reflect.get(record, "translationGroup");
				if (typeof group === "string") keys.add(group);
				if (record.kind === "collection") keys.add(record.slug);
				if (record.kind === "menu") keys.add(record.name);
			}
			index.set(kind, keys);
		}
		for (const [kind, list] of records) {
			for (const reference of KIND_REFERENCES[kind as keyof typeof KIND_REFERENCES]) {
				for (const record of list) {
					const value: unknown = Reflect.get(record, reference.property);
					const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
					for (const target of values) {
						const found = reference.targets.some((t) => index.get(t)?.has(String(target)));
						expect(found, `${kind}.${reference.property} → ${String(target)}`).toBe(true);
					}
				}
			}
		}
	});

	it("re-exports an unchanged site byte for byte apart from package id and time", async () => {
		const first = await packageFiles((await runExport(ctx.db, storage)).reader);
		const second = await packageFiles((await runExport(ctx.db, storage)).reader);
		expect([...second.keys()]).toEqual([...first.keys()]);
		for (const [path, bytes] of first) {
			if (path === MANIFEST_PATH) continue;
			expect(decoder.decode(second.get(path)), path).toBe(decoder.decode(bytes));
		}
		const strip = (bytes: Uint8Array | undefined) => {
			const { packageId: _id, createdAt: _at, ...rest } = JSON.parse(decoder.decode(bytes));
			return rest;
		};
		expect(strip(second.get(MANIFEST_PATH))).toEqual(strip(first.get(MANIFEST_PATH)));
	});

	it("keeps referenced media that is not ready and nulls references to media without a file", async () => {
		const avatar = site.media.find((item) => item.id === site.ids.avatarMedia)!;
		await ctx.db
			.updateTable("media")
			.set({ status: "pending" })
			.where("id", "in", [site.ids.avatarMedia, site.ids.heroMedia])
			.execute();
		storage.files.delete(avatar.storageKey);

		const { result, reader } = await runExport(ctx.db, storage);
		expect(result.outcome).toBe("complete");
		const records = await packageRecords(reader);
		const media = byId(records.get("media"));
		// The hero is pending but a section preview references it and its file exists.
		expect(media.has(site.ids.heroMedia)).toBe(true);
		expect(media.has(site.ids.avatarMedia)).toBe(false);
		const alice = byId(records.get("byline")).get(site.ids.aliceEn);
		expect(alice?.kind).toBe("byline");
		expect(alice && "avatarMediaId" in alice).toBe(false);

		const transformations = Object.fromEntries(
			(await reader.manifest()).transformations.map((t) => [`${t.code}:${t.kind}`, t.count]),
		);
		expect(transformations["avatar_nulled:byline"]).toBe(1);
		expect(transformations["media_not_ready_dropped:media"]).toBe(2);
	});

	it("fails when a ready media file is missing", async () => {
		const logo = site.media.find((item) => item.id === site.ids.logoMedia)!;
		storage.files.delete(logo.storageKey);
		const { result } = await runExport(ctx.db, storage);
		expect(result.outcome).toBe("failed");
		expect(result.operation.errorCode).toBe("TRANSFER_MEDIA_BLOB_MISSING");
		expect(result.operation.errorDetail).toEqual({ mediaId: site.ids.logoMedia });
	});

	it("leaves comments out when asked", async () => {
		const { reader } = await runExport(ctx.db, storage, { exportOptions: { comments: false } });
		const manifest = await reader.manifest();
		expect(manifest.records.comment).toBeUndefined();
		expect(manifest.records.comment_reaction).toBeUndefined();
		expect(manifest.features).not.toContain("comments");
	});
});
