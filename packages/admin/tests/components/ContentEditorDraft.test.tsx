import { Toasty } from "@cloudflare/kumo";
import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import type { AdminManifest, ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// Reads its value once on mount, as the real rich text editor does, so a field only shows a
// new value after it remounts. The module's other exports, the converter included, stay real.
const richText = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("../../src/components/PortableTextEditor", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/components/PortableTextEditor")>()),
	PortableTextEditor: ({ value }: { value: unknown[] }) => {
		const [initialValue] = React.useState(() => value);
		React.useEffect(() => {
			richText.mounts++;
		}, []);
		return <div data-testid="portable-text-editor" data-content={blockText(initialValue)} />;
	},
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => null,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => null,
}));

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
	Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
	useBlocker: () => ({ status: "idle" }),
}));

vi.mock("../../src/lib/api", async () => ({
	...(await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api")),
	fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

function textBlocks(text: string) {
	return [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: "s1", text, marks: [] }],
		},
	];
}

function blockText(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.map((block: { children?: Array<{ text?: string }> }) =>
			(block.children ?? []).map((child) => child.text ?? "").join(""),
		)
		.join("\n");
}

function richTextContent(field: string): string | null | undefined {
	return document
		.querySelector(`#field-${field} [data-testid='portable-text-editor']`)
		?.getAttribute("data-content");
}

const FIELDS: Record<string, FieldDescriptor> = {
	title: { kind: "string", type: "string", label: "Title" },
	body: { kind: "portableText", type: "portableText", label: "Body" },
};

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		locale: "en",
		data: { title: "My post", body: textBlocks("Saved body") },
		authorId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		_rev: "rev-1",
		...overrides,
	};
}

function sandboxedManifest(): AdminManifest {
	return {
		version: "1.0.0",
		hash: "editor-draft",
		authMode: "passkey",
		collections: {},
		plugins: {
			translator: {
				enabled: true,
				adminMode: "blocks",
				editorActions: [
					{
						id: "translate",
						label: "Translate",
						route: "translate",
						placement: "toolbar",
						draft: { read: { fields: ["title", "body"] }, patch: { fields: ["title", "body"] } },
					},
				],
			},
		},
		taxonomies: [],
	};
}

function editorProps(props: Partial<ContentEditorProps> = {}): ContentEditorProps {
	return {
		collection: "posts",
		collectionLabel: "Post",
		fields: FIELDS,
		isNew: false,
		item: makeItem(),
		onSave: vi.fn(),
		onAutosave: vi.fn(),
		...props,
	};
}

/** Answers the sandboxed action with `operations`, as the server does for a current draft. */
function stubSandboxedPatch(operations: EditorDraftPatchOperation[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (!url.includes("/plugin-extensions/translator/action/translate")) {
				throw new Error(`Unhandled request: ${url}`);
			}
			if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
			const { draft } = JSON.parse(init.body);
			return Response.json({
				data: {
					patch: { type: "editor-draft-patch", operations },
					editorInvocation: {
						entryId: draft.entryId,
						locale: draft.locale,
						baseRevision: draft.baseRevision,
						generation: draft.generation,
						invocationId: draft.invocationId,
						fieldDefinitions: [
							{
								slug: "title",
								label: "Title",
								type: "string",
								required: false,
								translatable: false,
							},
							{
								slug: "body",
								label: "Body",
								type: "portableText",
								required: false,
								translatable: false,
							},
						],
					},
				},
			});
		}),
	);
}

async function applySandboxedPatch(screen: Awaited<ReturnType<typeof render>>) {
	await screen.getByRole("button", { name: "Translate", exact: true }).click();
	const preview = screen.getByRole("dialog", { name: "Review proposed changes" });
	const apply = preview.getByRole("button", { name: "Apply changes", exact: true });
	await expect.element(apply).toBeVisible();
	apply.element().click();
	await expect.element(preview).not.toBeInTheDocument();
}

describe("sandboxed editor draft patches", () => {
	beforeEach(() => {
		richText.mounts = 0;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a sandboxed rich text patch in the editor after Apply", async () => {
		stubSandboxedPatch([{ op: "set", field: "body", value: textBlocks("Translated body") }]);
		const props = editorProps({ manifest: sandboxedManifest() });
		const screen = await render(<ContentEditor {...props} />, { wrapper: Toasty });
		expect(richTextContent("body")).toBe("Saved body");

		await applySandboxedPatch(screen);

		await vi.waitFor(() => expect(richTextContent("body")).toBe("Translated body"));
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		expect(props.onSave).not.toHaveBeenCalled();
	});

	it("refuses a sandboxed rich text value the editor can't load and changes nothing", async () => {
		stubSandboxedPatch([
			{ op: "set", field: "title", value: "Translated title" },
			{ op: "set", field: "body", value: [{ _type: "block" }] },
		]);
		const props = editorProps({ manifest: sandboxedManifest() });
		const screen = await render(<ContentEditor {...props} />, { wrapper: Toasty });

		await applySandboxedPatch(screen);

		const banner = screen.getByRole("alert").filter({ hasText: "Plugin changes were not applied" });
		await expect
			.element(banner)
			.toHaveTextContent("The plugin proposed a value this editor can't load.");
		await expect.element(screen.getByLabelText("Title")).toHaveValue("My post");
		expect(richTextContent("body")).toBe("Saved body");
		expect(richText.mounts).toBe(1);
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
	});
});
