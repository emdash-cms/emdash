import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#import/ssrf.js", () => ({
	validateExternalUrl: () => {},
	SsrfError: class SsrfError extends Error {},
	ssrfSafeFetch: async (url: string) =>
		new Response(new TextEncoder().encode(`bytes of ${url}`), {
			status: 200,
			headers: { "content-type": "image/jpeg" },
		}),
}));

import { POST as analyzePost } from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import {
	POST as mediaPost,
	type MediaImportResult,
} from "../../../src/astro/routes/api/import/wordpress/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
	xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wp="http://wordpress.org/export/1.2/">
	<channel>
		<title>Test Site</title>
		<link>https://example.com</link>
		<item>
			<title>Harbour at dusk</title>
			<content:encoded><![CDATA[]]></content:encoded>
			<excerpt:encoded><![CDATA[The harbour, photographed from the pier]]></excerpt:encoded>
			<wp:post_id>21</wp:post_id>
			<wp:post_type>attachment</wp:post_type>
			<wp:status>inherit</wp:status>
			<wp:attachment_url>https://example.com/wp-content/uploads/harbour.jpg</wp:attachment_url>
			<wp:postmeta>
				<wp:meta_key>_wp_attachment_image_alt</wp:meta_key>
				<wp:meta_value><![CDATA[Boats moored in a harbour at dusk]]></wp:meta_value>
			</wp:postmeta>
		</item>
	</channel>
</rss>`;

function fakeStorage(): Storage {
	const storage: Pick<Storage, "upload"> = {
		async upload(o) {
			return { key: o.key, url: `/m/${o.key}`, size: 0 };
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- upload is the only method the import uses
	return storage as Storage;
}

async function analyzeWxr(xml: string) {
	const formData = new FormData();
	formData.append("file", new File([xml], "export.xml", { type: "text/xml" }));
	const response = await analyzePost(
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro context
		{
			request: new Request("http://localhost/_emdash/api/import/wordpress/analyze", {
				method: "POST",
				body: formData,
			}),
			locals: { user: { id: "test-admin", role: 50 } },
		} as any,
	);
	expect(response.status).toBe(200);
	const { data } = (await response.json()) as {
		data: { attachments: { items: Record<string, unknown>[] } };
	};
	return data.attachments.items;
}

async function importMedia(
	db: Kysely<Database>,
	attachments: Record<string, unknown>[],
): Promise<MediaImportResult> {
	const request = new Request("http://localhost/_emdash/api/import/wordpress/media", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({ stream: false, attachments }),
	});
	const response = await mediaPost({
		request,
		locals: {
			emdash: { db, storage: fakeStorage(), config: { imagePlaceholders: false } },
			user: { id: "test-admin", role: 50 },
		},
	} as unknown as APIContext);
	expect(response.status).toBe(200);
	const { data } = (await response.json()) as { data: MediaImportResult };
	return data;
}

describe("WordPress import: media alt text and captions", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function importedMedia(result: MediaImportResult) {
		const repo = new MediaRepository(db);
		return Promise.all(result.imported.map((item) => repo.findById(item.mediaId)));
	}

	it("keeps the alt text and caption of a WXR attachment", async () => {
		const attachments = await analyzeWxr(WXR);

		const result = await importMedia(db, attachments);

		const [media] = await importedMedia(result);
		expect(media).toMatchObject({
			alt: "Boats moored in a harbour at dusk",
			caption: "The harbour, photographed from the pier",
		});
	});

	it("keeps the alt text and caption the EmDash Exporter sends", async () => {
		const result = await importMedia(db, [
			{
				id: 31,
				url: "https://example.com/wp-content/uploads/pier.jpg",
				filename: "pier.jpg",
				mimeType: "image/jpeg",
				alt: "A wooden pier",
				caption: "The old pier",
			},
			{
				id: 32,
				url: "https://example.com/wp-content/uploads/sky.jpg",
				filename: "sky.jpg",
				mimeType: "image/jpeg",
				alt: "",
				caption: "",
			},
		]);

		const [pier, sky] = await importedMedia(result);
		expect(pier).toMatchObject({ alt: "A wooden pier", caption: "The old pier" });
		expect(sky).toMatchObject({ alt: null, caption: null });
	});
});
