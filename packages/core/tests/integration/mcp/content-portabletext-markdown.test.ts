/**
 * MCP content_create / content_update accept markdown strings for
 * portableText fields and convert them to Portable Text, matching the
 * `emdash` CLI client (`convertDataForWrite`). LLM callers reliably produce
 * markdown but not valid Portable Text JSON (unique `_key`s, `markDefs`,
 * block shapes), so without this the only way to write rich text over MCP is
 * to hand-assemble PT JSON — which fails validation when it's malformed.
 *
 * Regression test for #1005 (MCP rejected markdown strings in portableText
 * fields with "expected array, received string").
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

type Item = { id: string; data: Record<string, unknown> };
type ItemEnvelope = { item: Item };
type PtBlock = { _type: string; style?: string };

function getContent(envelope: ItemEnvelope): unknown {
	return envelope.item.data.content;
}

describe("MCP content markdown -> portableText (#1005)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("content_create converts a markdown string in a portableText field", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				slug: "md-create",
				data: { title: "Test", content: "## Heading\n\nSome **bold** text." },
			},
		});
		expect(isErrorResult(created), extractText(created)).toBe(false);

		const id = extractJson<ItemEnvelope>(created).item.id;
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = getContent(extractJson<ItemEnvelope>(got));
		expect(Array.isArray(content)).toBe(true);
		const blocks = content as PtBlock[];
		expect(blocks[0]?._type).toBe("block");
		expect(blocks[0]?.style).toBe("h2");
	});

	it("content_update converts a markdown string in a portableText field", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", slug: "md-update", data: { title: "Test" } },
		});
		const id = extractJson<ItemEnvelope>(created).item.id;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { content: "Just a **paragraph**." } },
		});
		expect(isErrorResult(updated), extractText(updated)).toBe(false);

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = getContent(extractJson<ItemEnvelope>(got));
		expect(Array.isArray(content)).toBe(true);
		expect((content as PtBlock[])[0]?._type).toBe("block");
	});

	it("content_create still accepts a Portable Text array unchanged", async () => {
		const block = {
			_type: "block",
			_key: "abc123",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: "s1", text: "Already PT", marks: [] }],
		};
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", slug: "pt-array", data: { title: "Test", content: [block] } },
		});
		expect(isErrorResult(created), extractText(created)).toBe(false);

		const id = extractJson<ItemEnvelope>(created).item.id;
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = getContent(extractJson<ItemEnvelope>(got)) as Array<{ _key: string }>;
		expect(content[0]?._key).toBe("abc123");
	});
});
