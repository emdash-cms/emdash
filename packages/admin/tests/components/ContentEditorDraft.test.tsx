import { Toasty } from "@cloudflare/kumo";
import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import { useRevisionViewContext } from "../../src/components/revisions/revision-view-context";
import type {
	AdminManifest,
	ContentItem,
	ContentSeo,
	RevisionListResponse,
} from "../../src/lib/api";
import type {
	ContentEditorDraft,
	ContentEditorDraftPatchResult,
	ContentEditorPanelContext,
} from "../../src/lib/content-editor-panels";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import { render } from "../utils/render.tsx";

// Reads its value once on mount, as the real rich text editor does, so a field only shows a
// new value after it remounts. The module's other exports, the converter included, stay real.
const richText = vi.hoisted(() => ({
	mounts: 0,
	props: null as null | {
		onChange: (value: unknown) => void;
		onBlockSidebarOpen?: (panel: unknown) => void;
		onBlockSidebarClose?: () => void;
	},
}));
vi.mock("../../src/components/PortableTextEditor", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/components/PortableTextEditor")>()),
	PortableTextEditor: (props: {
		value: unknown[];
		onChange: (value: unknown) => void;
		onBlockSidebarOpen?: (panel: unknown) => void;
		onBlockSidebarClose?: () => void;
	}) => {
		richText.props = props;
		const [initialValue] = React.useState(() => props.value);
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

// Stands in for the version list: one button opens an older version in the revision view.
vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: function MockRevisionHistory() {
		const view = useRevisionViewContext();
		return view ? (
			<button
				type="button"
				onClick={(event) => view.view("rev-old", { opener: event.currentTarget })}
			>
				View rev-old
			</button>
		) : null;
	},
}));

vi.mock("../../src/components/revisions/RevisionViewCanvas", () => ({
	RevisionViewCanvas: ({ label }: { label: string }) => <article aria-label={label} />,
}));

vi.mock("../../src/lib/revision-diff/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/revision-diff/index.js")>()),
	diffVersion: vi.fn(() => ({ hasPrevious: false, fields: [], slug: null, changes: [] })),
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
	fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
	fetchRevisions: vi.fn(
		async (): Promise<RevisionListResponse> => ({
			items: ["rev-draft", "rev-old"].map((id) => ({
				id,
				collection: "posts",
				entryId: "item-1",
				data: { title: id },
				authorId: null,
				author: null,
				createdAt: "2026-01-01 00:00:00",
			})),
			total: 2,
		}),
	),
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

function seoOf(title: string | null, description: string | null = null): ContentSeo {
	return { title, description, image: null, canonical: null, noIndex: false };
}

const FIELDS: Record<string, FieldDescriptor> = {
	title: { kind: "string", type: "string", label: "Title" },
	body: { kind: "portableText", type: "portableText", label: "Body" },
};

const DRAFT_FIELDS: Record<string, FieldDescriptor> = {
	title: { kind: "string", type: "string", label: "Title", required: true, translatable: true },
	excerpt: {
		kind: "richText",
		type: "text",
		label: "Excerpt",
		translatable: true,
		validation: { maxLength: 160 },
	},
	featured: { kind: "boolean", type: "boolean", label: "Featured" },
	body: { kind: "portableText", type: "portableText", label: "Body", translatable: true },
	layout: { kind: "blocks", type: "blocks", label: "Layout" },
	author: {
		kind: "reference",
		type: "reference",
		label: "Author",
		validation: { relation: "post_author", targetCollection: "people" },
	},
};

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		locale: "en",
		translationGroup: null,
		data: {
			title: "My post",
			excerpt: "Saved excerpt",
			featured: 1,
			body: textBlocks("Saved body"),
			layout: [],
		},
		authorId: null,
		primaryBylineId: null,
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

const SANDBOXED_TRANSLATOR: AdminManifest["plugins"] = {
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
};

function manifestWith(plugins: AdminManifest["plugins"]): AdminManifest {
	return {
		version: "1.0.0",
		hash: "editor-draft",
		authMode: "passkey",
		collections: {},
		plugins,
		taxonomies: [],
	};
}

/** Answers the sandboxed action with `operations`, as the server does for a current draft. */
function stubSandboxedPatch(
	operations: EditorDraftPatchOperation[],
	fields: Record<string, FieldDescriptor>,
) {
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
						fieldDefinitions: operations.map(({ field }) => ({
							slug: field,
							label: fields[field]?.label ?? field,
							type: fields[field]?.type,
							required: Boolean(fields[field]?.required),
							translatable: Boolean(fields[field]?.translatable),
						})),
					},
				},
			});
		}),
	);
}

async function openSandboxedPreview(screen: Awaited<ReturnType<typeof render>>) {
	await screen.getByRole("button", { name: "Translate", exact: true }).click();
	const preview = screen.getByRole("dialog", { name: "Review proposed changes" });
	const apply = preview.getByRole("button", { name: "Apply changes", exact: true });
	await expect.element(apply).toBeVisible();
	return {
		async apply() {
			apply.element().click();
			await expect.element(preview).not.toBeInTheDocument();
		},
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

describe("sandboxed editor draft patches", () => {
	beforeEach(() => {
		richText.mounts = 0;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a sandboxed rich text patch in the editor after Apply", async () => {
		stubSandboxedPatch(
			[{ op: "set", field: "body", value: textBlocks("Translated body") }],
			FIELDS,
		);
		const props = editorProps({ manifest: manifestWith(SANDBOXED_TRANSLATOR) });
		const screen = await render(<ContentEditor {...props} />, { wrapper: Toasty });
		expect(richTextContent("body")).toBe("Saved body");

		await (await openSandboxedPreview(screen)).apply();

		await vi.waitFor(() => expect(richTextContent("body")).toBe("Translated body"));
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		expect(props.onSave).not.toHaveBeenCalled();
	});

	it("refuses a sandboxed rich text value the editor can't load and changes nothing", async () => {
		stubSandboxedPatch(
			[
				{ op: "set", field: "title", value: "Translated title" },
				{ op: "set", field: "body", value: [{ _type: "block" }] },
			],
			FIELDS,
		);
		const props = editorProps({ manifest: manifestWith(SANDBOXED_TRANSLATOR) });
		const screen = await render(<ContentEditor {...props} />, { wrapper: Toasty });

		await (await openSandboxedPreview(screen)).apply();

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

/** What the trusted panel has received: its render count and each `editorDraft` it was given. */
const panel = { renders: 0, drafts: [] as Array<ContentEditorDraft | undefined> };

function DraftToolsPanel({ editorDraft }: ContentEditorPanelContext) {
	panel.renders++;
	if (panel.drafts.at(-1) !== editorDraft) panel.drafts.push(editorDraft);
	return <p data-testid="draft-tools">Draft tools</p>;
}

const PLUGIN_ADMINS: PluginAdmins = {
	drafts: {
		contentEditorPanels: [{ id: "draft-tools", title: "Draft tools", component: DraftToolsPanel }],
	},
};

function TrustedEditor(props: ContentEditorProps) {
	return (
		<PluginAdminProvider pluginAdmins={PLUGIN_ADMINS}>
			<ContentEditor {...props} />
		</PluginAdminProvider>
	);
}

/** Calls `onCleanup` from a layout cleanup, which runs after those of the siblings before it. */
function LayoutCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
	React.useLayoutEffect(() => onCleanup, [onCleanup]);
	return null;
}

async function renderTrusted(overrides: Partial<ContentEditorProps> = {}) {
	const props = editorProps({ fields: DRAFT_FIELDS, ...overrides });
	const screen = await render(<TrustedEditor {...props} />, { wrapper: Toasty });
	await expect.element(screen.getByTestId("draft-tools")).toBeInTheDocument();
	return { screen, props };
}

function currentDraft(): ContentEditorDraft {
	const draft = panel.drafts.at(-1);
	if (!draft) throw new Error("The trusted panel has no editorDraft");
	return draft;
}

function patchCurrent(draft: ContentEditorDraft, operations: EditorDraftPatchOperation[]) {
	return draft.patch(operations, { expectedRevision: draft.get().revision });
}

const RETIRED = { revision: "", readOnly: true, fields: {}, fieldDefinitions: [] };

function openBlockSidebar() {
	richText.props?.onBlockSidebarOpen?.({
		type: "image",
		attrs: { src: "https://example.com/image.png", alt: "Example" },
		onUpdate: vi.fn(),
		onReplace: vi.fn(),
		onDelete: vi.fn(),
		onClose: vi.fn(),
	});
}

describe("trusted panel draft access", () => {
	beforeEach(() => {
		panel.renders = 0;
		panel.drafts = [];
		richText.mounts = 0;
		richText.props = null;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reads typed, unsaved values with exact definitions, and leaves bound references out", async () => {
		const { screen } = await renderTrusted();
		await screen.getByLabelText("Title", { exact: true }).fill("Typed title");

		const snapshot = currentDraft().get();
		expect(snapshot.readOnly).toBe(false);
		expect(snapshot.fields).toEqual({
			title: "Typed title",
			excerpt: "Saved excerpt",
			featured: 1,
			body: textBlocks("Saved body"),
			layout: [],
			slug: "my-post",
		});
		expect(snapshot.fieldDefinitions).toEqual([
			{ slug: "title", label: "Title", type: "string", required: true, translatable: true },
			{
				slug: "excerpt",
				label: "Excerpt",
				type: "text",
				required: false,
				translatable: true,
				validation: { maxLength: 160 },
			},
			{
				slug: "featured",
				label: "Featured",
				type: "boolean",
				required: false,
				translatable: false,
			},
			{ slug: "body", label: "Body", type: "portableText", required: false, translatable: true },
			{ slug: "layout", label: "Layout", type: "blocks", required: false, translatable: false },
			{ slug: "slug", label: "Slug", type: "slug", required: false, translatable: true },
		]);
	});

	it("includes the SEO text, typed moments earlier included, in a collection with SEO", async () => {
		const onSeoChange = vi.fn();
		const { screen } = await renderTrusted({
			hasSeo: true,
			onSeoChange,
			item: makeItem({ seo: seoOf("Saved SEO title") }),
		});

		await screen.getByLabelText("Meta Description").fill("Typed description");

		expect(currentDraft().get().fields).toMatchObject({
			slug: "my-post",
			"seo.title": "Saved SEO title",
			"seo.description": "Typed description",
		});
		expect(onSeoChange).not.toHaveBeenCalled();
	});

	it("patches the slug of an entry without one, autosaves it, and keeps it through a title edit", async () => {
		vi.useFakeTimers();
		const { screen, props } = await renderTrusted({ item: makeItem({ slug: null }) });
		const draft = currentDraft();
		const slug = screen.getByLabelText("Slug", { exact: true });

		expect(patchCurrent(draft, [{ op: "set", field: "slug", value: "bonjour" }])).toEqual({
			ok: true,
		});
		await expect.element(slug).toHaveValue("bonjour");
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(props.onAutosave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ slug: "bonjour", keepReplacedRevision: true }),
		);

		await screen.getByLabelText("Title", { exact: true }).fill("Un titre");
		await expect.element(slug).toHaveValue("bonjour");
		expect(patchCurrent(draft, [{ op: "clear", field: "slug" }])).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_INVALID",
		});
		expect(props.onSave).not.toHaveBeenCalled();
	});

	it("shows a seo.title patch in the SEO panel, which saves it without making the form dirty", async () => {
		vi.useFakeTimers();
		const onSeoChange = vi.fn();
		const { screen, props } = await renderTrusted({ hasSeo: true, onSeoChange });
		const draft = currentDraft();

		expect(
			patchCurrent(draft, [{ op: "set", field: "seo.title", value: "x".repeat(201) }]),
		).toMatchObject({ ok: false, code: "EDITOR_DRAFT_INVALID" });
		expect(patchCurrent(draft, [{ op: "set", field: "seo.title", value: "Hola" }])).toEqual({
			ok: true,
		});
		await expect.element(screen.getByLabelText("SEO Title", { exact: true })).toHaveValue("Hola");
		expect(onSeoChange).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(500);
		expect(onSeoChange).toHaveBeenCalledExactlyOnceWith({
			title: "Hola",
			description: null,
			canonical: null,
			noIndex: false,
		});
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
		await vi.advanceTimersByTimeAsync(2500);
		expect(props.onAutosave).not.toHaveBeenCalled();
	});

	it("saves a seo.title patch at once while the block sidebar is open, and shows it after", async () => {
		const onSeoChange = vi.fn();
		const { screen } = await renderTrusted({ hasSeo: true, onSeoChange });
		const draft = currentDraft();
		openBlockSidebar();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

		expect(patchCurrent(draft, [{ op: "set", field: "seo.title", value: "Hola" }])).toEqual({
			ok: true,
		});
		expect(onSeoChange).toHaveBeenCalledExactlyOnceWith({ title: "Hola" });
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

		richText.props?.onBlockSidebarClose?.();
		await expect.element(screen.getByLabelText("SEO Title", { exact: true })).toHaveValue("Hola");
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onSeoChange).toHaveBeenCalledTimes(1);
	});

	it("saves a seo.title patch at once when the same patch closes the block sidebar", async () => {
		const onSeoChange = vi.fn();
		const { screen } = await renderTrusted({ hasSeo: true, onSeoChange });
		const draft = currentDraft();
		openBlockSidebar();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

		expect(
			patchCurrent(draft, [
				{ op: "set", field: "seo.title", value: "Hola" },
				{ op: "set", field: "body", value: textBlocks("Hola body") },
			]),
		).toEqual({ ok: true });

		expect(onSeoChange).toHaveBeenCalledExactlyOnceWith({ title: "Hola" });
		await expect.element(screen.getByRole("button", { name: "Remove" })).not.toBeInTheDocument();
		await expect.element(screen.getByLabelText("SEO Title", { exact: true })).toHaveValue("Hola");
		expect(richTextContent("body")).toBe("Hola body");
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onSeoChange).toHaveBeenCalledTimes(1);
	});

	it("follows a newer saved SEO title while the block sidebar is open, and keeps it in the next SEO save", async () => {
		const onSeoChange = vi.fn();
		const { screen, props } = await renderTrusted({
			hasSeo: true,
			onSeoChange,
			item: makeItem({ seo: seoOf("Saved SEO title") }),
		});
		openBlockSidebar();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

		await screen.rerender(
			<TrustedEditor
				{...props}
				item={makeItem({ seo: seoOf("Newer SEO title"), _rev: "rev-2" })}
			/>,
		);
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
		expect(currentDraft().get().fields["seo.title"]).toBe("Newer SEO title");

		richText.props?.onBlockSidebarClose?.();
		await expect
			.element(screen.getByLabelText("SEO Title", { exact: true }))
			.toHaveValue("Newer SEO title");
		await screen.getByRole("switch", { name: "Hide from search engines" }).click();
		expect(onSeoChange).toHaveBeenCalledExactlyOnceWith({
			title: "Newer SEO title",
			description: null,
			canonical: null,
			noIndex: true,
		});
	});

	it("keeps a seo.title patch saved while the block sidebar is open through a read that doesn't reflect it", async () => {
		const onSeoChange = vi.fn();
		const { screen, props } = await renderTrusted({ hasSeo: true, onSeoChange });
		openBlockSidebar();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
		expect(
			patchCurrent(currentDraft(), [{ op: "set", field: "seo.title", value: "Hola" }]),
		).toEqual({ ok: true });

		await screen.rerender(
			<TrustedEditor
				{...props}
				item={makeItem({ seo: seoOf("Other tab title"), _rev: "rev-2" })}
			/>,
		);
		expect(currentDraft().get().fields["seo.title"]).toBe("Hola");

		richText.props?.onBlockSidebarClose?.();
		await expect.element(screen.getByLabelText("SEO Title", { exact: true })).toHaveValue("Hola");
	});

	it("is stale after an edit to the slug, the SEO title or the meta description", async () => {
		const { screen } = await renderTrusted({ hasSeo: true, onSeoChange: vi.fn() });
		const draft = currentDraft();

		for (const [label, text] of [
			["Slug", "edited-slug"],
			["SEO Title", "Edited SEO title"],
			["Meta Description", "Edited description"],
		] as const) {
			const { revision } = draft.get();
			await screen.getByLabelText(label, { exact: true }).fill(text);
			expect(
				draft.patch([{ op: "set", field: "title", value: "Late" }], { expectedRevision: revision }),
			).toMatchObject({ ok: false, code: "EDITOR_DRAFT_STALE" });
		}
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("My post");
	});

	it("shows patched values, a rich text field included, and marks the form dirty without saving", async () => {
		vi.useFakeTimers();
		const { screen, props } = await renderTrusted();
		const draft = currentDraft();

		expect(
			patchCurrent(draft, [
				{ op: "set", field: "title", value: "Hola" },
				{ op: "set", field: "body", value: textBlocks("Hola body") },
			]),
		).toEqual({ ok: true });

		expect(draft.get().fields).toMatchObject({ title: "Hola", body: textBlocks("Hola body") });
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("Hola");
		await expect
			.element(screen.getByTestId("portable-text-editor"))
			.toHaveAttribute("data-content", "Hola body");
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		expect(props.onSave).not.toHaveBeenCalled();
		expect(props.onAutosave).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2000);
		expect(props.onAutosave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				data: expect.objectContaining({ title: "Hola", body: textBlocks("Hola body") }),
				keepReplacedRevision: true,
			}),
		);
	});

	it("is stale after an edit to any draft field, a rich text edit that hasn't rendered included", async () => {
		const { screen } = await renderTrusted();
		const draft = currentDraft();
		const late: EditorDraftPatchOperation[] = [{ op: "set", field: "title", value: "Late" }];

		let { revision } = draft.get();
		await screen.getByLabelText("Excerpt").fill("Edited excerpt");
		expect(draft.patch(late, { expectedRevision: revision })).toMatchObject({
			code: "EDITOR_DRAFT_STALE",
		});

		revision = draft.get().revision;
		richText.props?.onChange(textBlocks("Typed body"));
		expect(draft.patch(late, { expectedRevision: revision })).toMatchObject({
			code: "EDITOR_DRAFT_STALE",
		});
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("My post");
	});

	it("retires the draft on an entry switch and on a switch back", async () => {
		const { screen, props } = await renderTrusted();
		const late: EditorDraftPatchOperation[] = [{ op: "set", field: "title", value: "Late" }];
		const title = screen.getByLabelText("Title", { exact: true });
		const first = currentDraft();
		const firstRevision = first.get().revision;

		await screen.rerender(
			<TrustedEditor
				{...props}
				item={makeItem({ id: "item-2", data: { ...makeItem().data, title: "Second post" } })}
			/>,
		);
		await expect.element(title).toHaveValue("Second post");
		const second = currentDraft();
		expect(second).not.toBe(first);
		expect(first.get()).toEqual(RETIRED);
		expect(first.patch(late, { expectedRevision: firstRevision })).toMatchObject({
			code: "EDITOR_DRAFT_STALE",
		});

		await screen.rerender(<TrustedEditor {...props} />);
		await expect.element(title).toHaveValue("My post");
		const third = currentDraft();
		expect(third).not.toBe(first);
		expect(first.get()).toEqual(RETIRED);
		expect(first.patch(late, { expectedRevision: firstRevision })).toMatchObject({
			code: "EDITOR_DRAFT_STALE",
		});
		expect(second.get()).toEqual(RETIRED);
	});

	it("retires the draft before later layout cleanups in the commit that unmounts the editor", async () => {
		let patchLate = () => {};
		const screen = await render(
			<>
				<TrustedEditor {...editorProps({ fields: DRAFT_FIELDS })} />
				<LayoutCleanupProbe onCleanup={() => patchLate()} />
			</>,
			{ wrapper: Toasty },
		);
		await expect.element(screen.getByTestId("draft-tools")).toBeInTheDocument();
		const draft = currentDraft();
		const { revision } = draft.get();
		let late: ContentEditorDraftPatchResult | undefined;
		patchLate = () => {
			late = draft.patch([{ op: "set", field: "title", value: "Late" }], {
				expectedRevision: revision,
			});
		};

		await screen.unmount();
		expect(late).toMatchObject({ ok: false, code: "EDITOR_DRAFT_STALE" });
		expect(draft.get()).toEqual(RETIRED);
	});

	it("is not stale after an autosave completes without edits", async () => {
		vi.useFakeTimers();
		const { screen, props } = await renderTrusted();
		await screen.getByLabelText("Title", { exact: true }).fill("Typed title");
		const draft = currentDraft();
		const { revision } = draft.get();
		await vi.advanceTimersByTimeAsync(2000);
		expect(props.onAutosave).toHaveBeenCalledTimes(1);

		const saved = makeItem({ data: { ...makeItem().data, title: "Typed title" }, _rev: "rev-2" });
		await screen.rerender(<TrustedEditor {...props} item={saved} autosaveCompletionToken={1} />);
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();

		expect(
			draft.patch([{ op: "set", field: "title", value: "Patched" }], {
				expectedRevision: revision,
			}),
		).toEqual({ ok: true });
	});

	it("makes an open sandboxed preview's Apply report a stale result", async () => {
		stubSandboxedPatch([{ op: "set", field: "title", value: "Sandboxed title" }], DRAFT_FIELDS);
		const { screen } = await renderTrusted({
			manifest: manifestWith({ ...SANDBOXED_TRANSLATOR, drafts: { enabled: true } }),
		});
		const preview = await openSandboxedPreview(screen);

		expect(
			patchCurrent(currentDraft(), [{ op: "set", field: "title", value: "Trusted title" }]),
		).toEqual({ ok: true });
		await preview.apply();

		await expect
			.element(screen.getByRole("alert").filter({ hasText: "Plugin changes were not applied" }))
			.toHaveTextContent(
				"The plugin result is stale because the editor changed while it was working.",
			);
		await expect
			.element(screen.getByLabelText("Title", { exact: true }))
			.toHaveValue("Trusted title");
	});

	it("closes an open block sidebar for a rich text or blocks patch, and leaves it open otherwise", async () => {
		const { screen } = await renderTrusted();
		const draft = currentDraft();
		const blockPanel = screen.getByRole("button", { name: "Remove" });

		openBlockSidebar();
		await expect.element(blockPanel).toBeInTheDocument();
		expect(patchCurrent(draft, [{ op: "set", field: "excerpt", value: "Hola" }])).toEqual({
			ok: true,
		});
		await expect.element(screen.getByLabelText("Excerpt")).toHaveValue("Hola");
		await expect.element(blockPanel).toBeInTheDocument();

		expect(
			patchCurrent(draft, [{ op: "set", field: "body", value: textBlocks("Hola body") }]),
		).toEqual({ ok: true });
		await expect.element(blockPanel).not.toBeInTheDocument();

		openBlockSidebar();
		await expect.element(blockPanel).toBeInTheDocument();
		expect(patchCurrent(draft, [{ op: "set", field: "layout", value: [] }])).toEqual({ ok: true });
		await expect.element(blockPanel).not.toBeInTheDocument();
	});

	it.each([
		["the editor is read-only", { readOnly: true }],
		[
			"the collection has a field type the editor doesn't support",
			{
				fields: {
					...DRAFT_FIELDS,
					future: {
						kind: "unsupported",
						label: "Future",
						unsupportedType: { type: "future_type", path: "type" },
					},
				},
			},
		],
	] as const)("refuses with EDITOR_DRAFT_READ_ONLY while %s", async (_case, overrides) => {
		const { screen } = await renderTrusted(overrides);
		const draft = currentDraft();

		expect(draft.get().readOnly).toBe(true);
		expect(patchCurrent(draft, [{ op: "set", field: "title", value: "Hola" }])).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_READ_ONLY",
		});
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("My post");
	});

	it("refuses with EDITOR_DRAFT_READ_ONLY while a version is open in the revision view", async () => {
		const { screen } = await renderTrusted({
			supportsRevisions: true,
			item: makeItem({ draftRevisionId: "rev-draft" }),
		});
		const draft = currentDraft();
		const operation: EditorDraftPatchOperation[] = [{ op: "set", field: "title", value: "Hola" }];

		await screen.getByRole("button", { name: "View rev-old" }).click();
		await expect.element(screen.getByRole("button", { name: "Back to editing" })).toBeVisible();
		expect(draft.get().readOnly).toBe(true);
		expect(patchCurrent(draft, operation)).toMatchObject({ code: "EDITOR_DRAFT_READ_ONLY" });

		await screen.getByRole("button", { name: "Back to editing" }).click();
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("My post");
		expect(patchCurrent(draft, operation)).toEqual({ ok: true });
	});

	it("leaves the form as it was when it refuses an invalid patch", async () => {
		const { screen } = await renderTrusted();
		const draft = currentDraft();
		const before = draft.get();

		expect(
			patchCurrent(draft, [
				{ op: "set", field: "title", value: "Hola" },
				{ op: "set", field: "body", value: [{ _type: "block" }] },
			]),
		).toMatchObject({ code: "EDITOR_DRAFT_INVALID" });
		expect(
			patchCurrent(draft, [
				{ op: "set", field: "title", value: "Hola" },
				{ op: "set", field: "featured", value: "yes" },
			]),
		).toMatchObject({ code: "EDITOR_DRAFT_INVALID" });

		expect(draft.get()).toEqual(before);
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("My post");
		expect(richTextContent("body")).toBe("Saved body");
		expect(richText.mounts).toBe(1);
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
	});

	it("writes back a boolean it read as 0 or 1", async () => {
		const { screen } = await renderTrusted();
		const draft = currentDraft();
		const { fields } = draft.get();
		expect(fields.featured).toBe(1);

		expect(
			patchCurrent(draft, [
				{ op: "set", field: "featured", value: fields.featured },
				{ op: "set", field: "title", value: "Hola" },
			]),
		).toEqual({ ok: true });
		await expect.element(screen.getByLabelText("Title", { exact: true })).toHaveValue("Hola");
		await expect.element(screen.getByRole("switch", { name: "Featured" })).toBeChecked();
	});

	it("doesn't re-render the trusted panel while the user types, and keeps one draft object", async () => {
		const { screen } = await renderTrusted();
		const renders = panel.renders;

		await screen.getByLabelText("Title", { exact: true }).fill("Typed title");
		await screen.getByLabelText("Excerpt").fill("Typed excerpt");
		richText.props?.onChange(textBlocks("Typed body"));
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

		expect(panel.renders).toBe(renders);
		expect(panel.drafts).toHaveLength(1);
	});
});
