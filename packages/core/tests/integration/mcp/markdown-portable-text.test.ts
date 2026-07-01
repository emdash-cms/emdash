/**
 * MCP content_create / content_update — Markdown -> Portable Text conversion.
 *
 * Agents emit the `content_create` arguments as one inline JSON blob. A rich
 * text field authored as a deeply nested Portable Text array makes that blob
 * large and easy to truncate/mis-escape, so the whole tool call fails to parse
 * before any handler runs. Accepting a Markdown string for `portableText`
 * fields collapses the array to a single scalar, mirroring what EmDashClient
 * already does on write. A Portable Text array is still accepted unchanged.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

interface PtSpan {
	_type: string;
	text?: string;
	marks?: string[];
}
interface PtBlock {
	_type: string;
	style?: string;
	children?: PtSpan[];
}

describe("MCP markdown -> Portable Text on write", () => {
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

	it("content_create converts a Markdown string for a portableText field", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: {
					title: "Weighing flour",
					content: "# Heading\n\nA paragraph with **bold** text.",
				},
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = extractJson<{ item: { data: { content: PtBlock[] } } }>(got).item.data.content;

		expect(Array.isArray(content)).toBe(true);
		expect(content[0]?._type).toBe("block");
		expect(content[0]?.style).toBe("h1");
		expect(content[0]?.children?.[0]?.text).toBe("Heading");

		const para = content[1];
		expect(para?.style).toBe("normal");
		const bold = para?.children?.find((s) => s.marks?.includes("strong"));
		expect(bold?.text).toBe("bold");
	});

	it("content_create leaves an already-Portable-Text value untouched", async () => {
		const block: PtBlock = {
			_type: "block",
			style: "normal",
			children: [{ _type: "span", text: "Pre-authored", marks: [] }],
		};
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Direct PT", content: [block] },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = extractJson<{ item: { data: { content: PtBlock[] } } }>(got).item.data.content;
		expect(content[0]?.children?.[0]?.text).toBe("Pre-authored");
	});

	it("content_get returns Portable Text by default and Markdown when requested", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Round trip", content: "## Sub\n\nBody text." },
			},
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const def = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const defContent = extractJson<{ item: { data: { content: unknown } } }>(def).item.data.content;
		expect(Array.isArray(defContent)).toBe(true);

		const md = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id, markdown: true },
		});
		const mdContent = extractJson<{ item: { data: { content: unknown } } }>(md).item.data.content;
		expect(typeof mdContent).toBe("string");
		expect(mdContent).toContain("## Sub");
		expect(mdContent).toContain("Body text.");
	});

	it("content_list returns Markdown for portableText fields when requested", async () => {
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Listed", content: "# Listed body" } },
		});

		const listed = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post", markdown: true },
		});
		const items = extractJson<{ items: Array<{ data: { content?: unknown } }> }>(listed).items;
		const withContent = items.find((i) => i.data.content != null);
		expect(typeof withContent?.data.content).toBe("string");
		expect(withContent?.data.content).toContain("# Listed body");
	});

	it("content_update converts a Markdown string for a portableText field", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T", content: "Initial." } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				data: { content: "## Updated\n\nNew body." },
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const content = extractJson<{ item: { data: { content: PtBlock[] } } }>(got).item.data.content;
		expect(content[0]?.style).toBe("h2");
		expect(content[0]?.children?.[0]?.text).toBe("Updated");
	});
});
