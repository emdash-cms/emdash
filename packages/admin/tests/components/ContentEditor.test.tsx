import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import {
	ContentEditor,
	type FieldDescriptor,
	type ContentEditorProps,
} from "../../src/components/ContentEditor";
import { fetchBylines } from "../../src/lib/api";
import type { BylineSummary, ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

function makeByline(overrides: Partial<BylineSummary> = {}): BylineSummary {
	return {
		id: "byline-1",
		slug: "jane-smith",
		displayName: "Jane Smith",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: false,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		locale: "en",
		translationGroup: null,
		...overrides,
	};
}

// Mock child components that have complex dependencies.
// The mock simulates the real editor's behaviour of freezing initial content on mount:
// it captures `value` once via useState initializer and never re-reads it.
// This is what makes the translation-switch bug observable in tests — the displayed
// content stays stale unless the component is forced to remount via a fresh `key`.
//
// It also mirrors the real component's onEditorReady contract: called with a stub
// editor on mount and with `null` on unmount, so consumers can clear stale refs
// before the next instance mounts.
let portableTextMountCount = 0;
type EditorReadyCall = { mockId: number | null };
let onEditorReadyCalls: EditorReadyCall[] = [];
const portableTextProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock("../../src/components/PortableTextEditor", () => ({
	PortableTextEditor: (props: Record<string, any>) => {
		const { value, placeholder, onEditorReady } = props;
		portableTextProps.current = props;
		// Mirror the real component: capture initial value once, never update.
		const [initialValue] = React.useState(() => value);
		const mountIdRef = React.useRef<number>(0);
		React.useEffect(() => {
			portableTextMountCount++;
			mountIdRef.current = portableTextMountCount;
		}, []);
		React.useEffect(() => {
			if (onEditorReady) {
				const id = mountIdRef.current || portableTextMountCount + 1;
				const stubEditor = { __mockId: id } as unknown;
				onEditorReadyCalls.push({ mockId: id });
				onEditorReady(stubEditor);
				return () => {
					onEditorReadyCalls.push({ mockId: null });
					onEditorReady(null);
				};
			}
			return undefined;
		}, [onEditorReady]);
		const text = Array.isArray(initialValue)
			? initialValue
					.map((b: any) => b?.children?.map((c: any) => c?.text ?? "").join("") ?? "")
					.join("\n")
			: "";
		return (
			<div data-testid="portable-text-editor" data-content={text}>
				{placeholder}
			</div>
		);
	},
}));

vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div data-testid="taxonomy-sidebar">Taxonomy</div>,
}));

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => <div data-testid="doc-outline">Outline</div>,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		getPreviewUrl: vi.fn().mockResolvedValue({ url: "https://example.com/preview" }),
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

const defaultFields: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title", required: true },
	body: { kind: "string", label: "Body" },
};

const MOVE_TO_TRASH_PATTERN = /Move to Trash/i;

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post", body: "Some content" },
		authorId: null,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

function renderEditor(props: Partial<ContentEditorProps> = {}) {
	const defaultProps: ContentEditorProps = {
		collection: "posts",
		collectionLabel: "Post",
		fields: defaultFields,
		isNew: true,
		onSave: vi.fn(),
		...props,
	};
	return render(<ContentEditor {...defaultProps} />);
}

function installMatchMedia(initialMatches: boolean) {
	let matches = initialMatches;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mediaQuery = {
		get matches() {
			return matches;
		},
		media: "(max-width: 1023px)",
		onchange: null,
		addEventListener: (_type: string, listener: unknown) => {
			if (typeof listener === "function")
				listeners.add(listener as (event: MediaQueryListEvent) => void);
		},
		removeEventListener: (_type: string, listener: unknown) => {
			if (typeof listener === "function") {
				listeners.delete(listener as (event: MediaQueryListEvent) => void);
			}
		},
		addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
			if (listener) listeners.add(listener);
		},
		removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
			if (listener) listeners.delete(listener);
		},
		dispatchEvent: () => true,
	} as MediaQueryList;
	// Only viewport-width queries get the simulated value. Everything else
	// (e.g. prefers-reduced-motion in SaveButton/Kumo) keeps its real default
	// so these tests exercise the normal animation code paths.
	const nonMatching = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => true,
		}) as unknown as MediaQueryList;
	const spy = vi
		.spyOn(window, "matchMedia")
		.mockImplementation((query: string) =>
			query.includes("max-width") ? mediaQuery : nonMatching(query),
		);

	return {
		setMatches(nextMatches: boolean) {
			matches = nextMatches;
			const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
			for (const listener of listeners) listener(event);
		},
		restore() {
			spy.mockRestore();
		},
	};
}

describe("ContentEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		portableTextMountCount = 0;
		onEditorReadyCalls = [];
		portableTextProps.current = null;
	});

	it("uses a task-oriented placeholder for portable text fields", async () => {
		await renderEditor({
			isNew: false,
			item: makeItem(),
			fields: { content: { kind: "portableText", label: "Content" } },
		});

		expect(portableTextProps.current?.placeholder).toBe("Start writing, or type '/' for commands");
	});

	it("uses one label and spacing rhythm across editor field types", async () => {
		const screen = await renderEditor({
			isNew: false,
			item: makeItem(),
			fields: {
				title: { kind: "string", label: "Title" },
				featured_image: { kind: "image", label: "Featured Image" },
				content: { kind: "portableText", label: "Content" },
				attachment: { kind: "file", label: "Attachment" },
			},
		});
		const contentLabelText = document.getElementById("field-content-label");
		expect(contentLabelText).not.toBeNull();
		const contentLabel = contentLabelText!.parentElement!;
		const featuredLabel = screen.getByText("Featured Image", { exact: true }).element();
		const attachmentLabel = screen.getByText("Attachment", { exact: true }).element();
		const fieldStack = contentLabel.parentElement?.parentElement;

		expect(contentLabelText).toHaveTextContent("Content");
		expect(contentLabel.tagName).toBe("LABEL");
		expect(contentLabel).toHaveClass("text-base", "font-medium");
		expect(contentLabel.parentElement).toHaveClass("grid", "gap-2");
		expect(featuredLabel).toHaveClass("text-base", "font-medium");
		expect(featuredLabel).not.toHaveClass("text-sm");
		expect(featuredLabel.parentElement).toHaveClass("flex", "items-center", "gap-1.5");
		expect(featuredLabel.parentElement?.parentElement).toHaveClass("grid", "gap-2");
		expect(attachmentLabel.parentElement).toHaveClass("grid", "gap-2");
		expect(fieldStack).toHaveClass("space-y-6");
	});

	it("shows featured image guidance in the shared instant help tooltip", async () => {
		const screen = await renderEditor({
			isNew: false,
			item: makeItem(),
			fields: {
				featured_image: { kind: "image", label: "Featured Image" },
			},
		});
		const helpTrigger = screen.getByRole("button", {
			name: "More information about Featured Image",
		});

		await userEvent.hover(helpTrigger.element());
		await expect
			.element(
				screen.getByText(
					"Used as the main visual for this post on listing pages and at the top of the post",
				),
			)
			.toBeVisible();
	});

	describe("block panel + mobile sheet sync", () => {
		const ptFields: Record<string, FieldDescriptor> = {
			content: { kind: "portableText", label: "Content" },
		};

		function makeBlockPanel() {
			return {
				type: "image",
				attrs: { src: "https://example.com/image.png", alt: "Example" },
				onUpdate: vi.fn(),
				onReplace: vi.fn(),
				onDelete: vi.fn(),
				onClose: vi.fn(),
			};
		}

		function getPanelHooks() {
			const open = portableTextProps.current?.onBlockSidebarOpen as
				| ((panel: unknown) => void)
				| undefined;
			const close = portableTextProps.current?.onBlockSidebarClose as (() => void) | undefined;
			expect(typeof open).toBe("function");
			expect(typeof close).toBe("function");
			return { open: open!, close: close! };
		}

		it("auto-opens the sheet for a block panel below lg and re-closes it after", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({ isNew: false, item: makeItem(), fields: ptFields });
				await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();
				// Sheet starts closed.
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }), { timeout: 100 })
					.not.toBeInTheDocument();

				const { open, close } = getPanelHooks();
				open(makeBlockPanel());

				// The sheet must open by itself, showing the block detail panel.
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "Remove Image" }))
					.toBeInTheDocument();

				// Closing the block panel restores the sheet's prior (closed) state.
				close();
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.not.toBeInTheDocument();
			} finally {
				media.restore();
			}
		});

		// Not covered: the "restore to previously-open sheet" branch. Real input
		// can't reach it below lg (the open sheet overlays the editor, so a block
		// can't be tapped while it's up), and triggering it programmatically trips
		// Kumo's focusout dismissal when the focused settings content is swapped
		// out — pinning that would test Kumo internals, not the sync.

		it("keeps the sheet closed for block panels in distraction-free mode", async () => {
			// The sheet's nav is hidden in DF, but Kumo's mobile backdrop is a
			// separate sibling: letting the sheet open would paint a full-screen
			// scrim over the writing surface with nothing visible to dismiss.
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({ isNew: false, item: makeItem(), fields: ptFields });
				await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();

				await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();
				const { open } = getPanelHooks();
				open(makeBlockPanel());

				// Sheet must not open (no nav, and the backdrop must not be scrimming).
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }), { timeout: 200 })
					.not.toBeInTheDocument();
				const backdrop = document.querySelector("[data-sidebar-backdrop]");
				expect(backdrop?.classList.contains("pointer-events-none") ?? true).toBe(true);

				// Exiting DF with the panel still active surfaces it in the sheet.
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "Remove Image" }))
					.toBeInTheDocument();
			} finally {
				media.restore();
			}
		});

		it("closes the sheet but keeps the block panel when crossing to desktop", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({ isNew: false, item: makeItem(), fields: ptFields });
				await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();

				const { open } = getPanelHooks();
				open(makeBlockPanel());
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.toBeInTheDocument();

				media.setMatches(false);

				// No sheet on desktop; the block panel now lives in the pane.
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.not.toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "Remove Image" }))
					.toBeInTheDocument();
			} finally {
				media.restore();
			}
		});
	});

	describe("slug generation", () => {
		it("auto-generates slug from title for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Hello World Post");

			const slugInput = screen.getByLabelText("Slug");
			await expect.element(slugInput).toHaveValue("hello-world-post");
		});

		it("slug accepts manual override", async () => {
			const screen = await renderEditor({ isNew: true });
			const slugInput = screen.getByLabelText("Slug");
			await slugInput.fill("custom-slug");
			await expect.element(slugInput).toHaveValue("custom-slug");

			// After manual edit, typing in title should NOT update slug
			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("New Title");
			await expect.element(slugInput).toHaveValue("custom-slug");
		});

		it("slug is editable for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			const slugInput = screen.getByLabelText("Slug");
			await expect.element(slugInput).toBeEnabled();
		});
	});

	describe("field rendering", () => {
		it("renders string fields as text inputs", async () => {
			const screen = await renderEditor({
				fields: { title: { kind: "string", label: "Title" } },
			});
			const input = screen.getByLabelText("Title");
			await expect.element(input).toBeInTheDocument();
		});

		it("renders boolean fields as switches", async () => {
			const screen = await renderEditor({
				fields: { featured: { kind: "boolean", label: "Featured" } },
			});
			const toggle = screen.getByRole("switch");
			await expect.element(toggle).toBeInTheDocument();
		});

		it("renders number fields as number inputs", async () => {
			const screen = await renderEditor({
				fields: { order: { kind: "number", label: "Order" } },
			});
			const input = screen.getByLabelText("Order");
			await expect.element(input).toHaveAttribute("type", "number");
		});

		it("renders select fields as select dropdowns", async () => {
			const screen = await renderEditor({
				fields: {
					color: {
						kind: "select",
						label: "Color",
						options: [
							{ value: "red", label: "Red" },
							{ value: "blue", label: "Blue" },
						],
					},
				},
			});
			// Select renders a combobox role
			const select = screen.getByRole("combobox");
			await expect.element(select).toBeInTheDocument();
		});

		it("renders multiSelect fields as checkbox group", async () => {
			const screen = await renderEditor({
				fields: {
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});
			const checkboxes = screen.getByRole("checkbox", { exact: false });
			await expect.element(checkboxes.first()).toBeInTheDocument();
			// All option labels should be present
			await expect.element(screen.getByText("News")).toBeInTheDocument();
			await expect.element(screen.getByText("Tech")).toBeInTheDocument();
			await expect.element(screen.getByText("Sports")).toBeInTheDocument();
		});

		it("toggling a multiSelect checkbox updates the saved value", async () => {
			const onSave = vi.fn();
			const item = makeItem({
				data: { title: "Test", tags: ["news", "sports"] },
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				onSave,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});

			const checkboxes = screen.getByRole("checkbox", { exact: false });
			const all = checkboxes.all();

			// Uncheck "sports" (index 2, currently checked)
			await all[2]!.click();
			await expect.element(all[2]!).not.toBeChecked();

			// Check "tech" (index 1, currently unchecked)
			await all[1]!.click();
			await expect.element(all[1]!).toBeChecked();

			// Save and verify the data sent to onSave
			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						tags: ["news", "tech"],
					}),
				}),
			);
		});

		it("multiSelect checkboxes reflect existing values", async () => {
			const item = makeItem({
				data: { title: "Test", tags: ["news", "sports"] },
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});
			// Verify the checkbox group renders with correct checked state via aria
			const checkboxes = screen.getByRole("checkbox", { exact: false });
			const all = checkboxes.all();
			// Should have 3 checkboxes
			expect(all).toHaveLength(3);
			// news (checked), tech (unchecked), sports (checked)
			await expect.element(all[0]!).toBeChecked();
			await expect.element(all[1]!).not.toBeChecked();
			await expect.element(all[2]!).toBeChecked();
		});

		it("renders file fields with a Select file button (not a plain text input)", async () => {
			// Regression test for #718: the "file" field kind used to fall through to the
			// default case and render a text input, making it impossible to actually attach
			// a file. It must render a media picker trigger instead.
			const screen = await renderEditor({
				fields: { attachment: { kind: "file", label: "Attachment" } },
				isNew: true,
			});

			// The button that opens the picker should be present and labeled with the
			// field's label (accessibility).
			const selectBtn = screen.getByRole("button", { name: /Select Attachment/i });
			await expect.element(selectBtn).toBeInTheDocument();

			// And there must not be a text input inside the file field region — the old
			// bug rendered an `<Input>` labeled "Attachment" as a plain text field.
			// Use the field id (`field-attachment`) as an unconditional positive selector.
			const fieldRoot = document.getElementById("field-attachment");
			expect(fieldRoot).not.toBeNull();
			const textInputs = fieldRoot!.querySelectorAll(
				'input:not([type="file"]):not([type="hidden"])',
			);
			expect(textInputs).toHaveLength(0);
		});

		it("renders existing file field values as a filename, not a text input", async () => {
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						size: 102400,
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});

			// Filename should be visible
			await expect.element(screen.getByText("report.pdf")).toBeInTheDocument();
			// Change button present (picker is wired up)
			await expect.element(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
		});

		it("renders 0-byte file size instead of hiding it", async () => {
			// Regression test: a previous truthiness check (`const hasSize = normalized?.size`)
			// hid the size label for valid 0-byte files even though `formatFileSize(0)`
			// returns "0 B".
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-empty",
						filename: "empty.txt",
						mimeType: "text/plain",
						size: 0,
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});

			await expect.element(screen.getByText("empty.txt")).toBeInTheDocument();
			// "0 B" must be rendered, not silently hidden
			await expect.element(screen.getByText(/0\s*B/)).toBeInTheDocument();
		});

		it("falls back to value.src and then value.id for local files without meta.storageKey", async () => {
			// Regression test: local files without meta.storageKey previously lost their
			// download link because the URL was only built from storageKey.
			const itemWithSrc = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-no-key",
						provider: "local",
						src: "/_emdash/api/media/file/file-no-key",
						filename: "backup.zip",
						mimeType: "application/zip",
						size: 2048,
					},
				},
			});
			const screen1 = await renderEditor({
				isNew: false,
				item: itemWithSrc,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});
			const link1 = screen1.getByRole("link", { name: "backup.zip" });
			await expect.element(link1).toHaveAttribute("href", "/_emdash/api/media/file/file-no-key");

			// When src is also missing, fall back to value.id
			const itemNoSrc = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-fallback",
						provider: "local",
						filename: "notes.txt",
						mimeType: "text/plain",
						size: 512,
					},
				},
			});
			const screen2 = await renderEditor({
				isNew: false,
				item: itemNoSrc,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});
			const link2 = screen2.getByRole("link", { name: "notes.txt" });
			await expect.element(link2).toHaveAttribute("href", "/_emdash/api/media/file/file-fallback");
		});

		it("does not render data: or javascript: URLs from external providers as links", async () => {
			// A hostile external provider plugin could return src: "javascript:..." or
			// "data:..."; the file field must not surface either as a clickable <a href>.
			// Filename should still display as plain text so the user can see what's set.
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "evil-1",
						provider: "evil",
						src: "javascript:alert(1)",
						filename: "ok.txt",
						mimeType: "text/plain",
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});

			// Filename renders…
			await expect.element(screen.getByText("ok.txt")).toBeInTheDocument();
			// …but never as a link with the hostile href.
			const fieldRoot = document.getElementById("field-attachment");
			expect(fieldRoot).not.toBeNull();
			expect(fieldRoot!.querySelector('a[href^="javascript:"]')).toBeNull();
			expect(fieldRoot!.querySelector('a[href^="data:"]')).toBeNull();
		});

		it("encodes path-unsafe characters in storageKey when building the local URL", async () => {
			// Server-generated storage keys are flat ULIDs today, but the schema
			// now allows clients to write any `meta.storageKey` string via the
			// content API. `?` or `#` would otherwise escape the path.
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "x",
						provider: "local",
						filename: "notes.txt",
						mimeType: "text/plain",
						meta: { storageKey: "abc?evil#frag" },
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});
			const link = screen.getByRole("link", { name: "notes.txt" });
			await expect
				.element(link)
				.toHaveAttribute("href", "/_emdash/api/media/file/abc%3Fevil%23frag");
		});

		it("Remove button clears the file field value", async () => {
			const onSave = vi.fn();
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						size: 1024,
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				onSave,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});

			await screen.getByRole("button", { name: "Remove Attachment" }).click();
			// The Select empty-state button replaces the filled state.
			await expect
				.element(screen.getByRole("button", { name: "Select Attachment" }))
				.toBeInTheDocument();

			await screen.getByRole("button", { name: "Save" }).first().click();
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ attachment: null }),
				}),
			);
		});

		it("renders datetime fields as datetime-local inputs", async () => {
			const screen = await renderEditor({
				fields: { recall_date: { kind: "datetime", label: "Recall date" } },
			});
			const input = screen.getByLabelText("Recall date");
			await expect.element(input).toHaveAttribute("type", "datetime-local");
		});

		it("displays a stored ISO datetime in the datetime-local input", async () => {
			// The validator stores datetimes as full ISO 8601 with "Z" + millis,
			// but <input type="datetime-local"> only accepts "YYYY-MM-DDTHH:mm".
			// Without conversion the browser silently renders an empty input.
			const item = makeItem({
				data: { title: "Recall", recall_date: "2026-02-26T09:30:00.000Z" },
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					recall_date: { kind: "datetime", label: "Recall date" },
				},
			});
			const input = screen.getByLabelText("Recall date");
			await expect.element(input).toHaveValue("2026-02-26T09:30");
		});

		it("saves datetime fields back as full ISO 8601 with Z and milliseconds", async () => {
			// datetime-local emits "YYYY-MM-DDTHH:mm" which the field's
			// `z.string().datetime().or(z.string().date())` schema rejects.
			// The widget must round-trip the value back to a validator-accepted shape.
			const onSave = vi.fn();
			const screen = await renderEditor({
				isNew: true,
				onSave,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					recall_date: { kind: "datetime", label: "Recall date" },
				},
			});

			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Recall");

			const dtInput = screen.getByLabelText("Recall date");
			await dtInput.fill("2026-02-26T09:30");

			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						recall_date: "2026-02-26T09:30:00.000Z",
					}),
				}),
			);
		});

		it("renders json fields as a textarea", async () => {
			const screen = await renderEditor({
				fields: { metadata: { kind: "json", label: "Metadata" } },
				isNew: true,
			});
			const textarea = screen.getByLabelText("Metadata");
			await expect.element(textarea).toBeInTheDocument();
			// JSON field uses a textarea element
			expect(textarea.element().tagName).toBe("TEXTAREA");
		});

		it("renders json fields with object values as formatted JSON", async () => {
			const jsonData = { foo: "bar", num: 42 };
			const screen = await renderEditor({
				fields: { metadata: { kind: "json", label: "Metadata" } },
				item: makeItem({ data: { title: "Test", body: "", metadata: jsonData } }),
			});
			const textarea = screen.getByLabelText("Metadata");
			await expect.element(textarea).toHaveValue(JSON.stringify(jsonData, null, 2));
		});
	});

	describe("saving", () => {
		it("save form calls onSave with formData including slug", async () => {
			const onSave = vi.fn();
			const screen = await renderEditor({ isNew: true, onSave });

			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Test Title");

			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ title: "Test Title" }),
					slug: "test-title",
					bylines: [],
				}),
			);
		});

		it("SaveButton shows correct dirty state for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			// New items are always dirty
			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await expect.element(saveBtn).toBeEnabled();
		});

		it("SaveButton is disabled for existing item with no changes", async () => {
			const item = makeItem();
			const screen = await renderEditor({ isNew: false, item });
			const saveBtn = screen.getByRole("button", { name: "Saved" }).first();
			await expect.element(saveBtn).toBeDisabled();
			expect(screen.getByRole("status").element().textContent).toBe("Saved");
		});

		// Strict per-locale hydration (migration 040) can return
		// `item.bylines = []` even when junction rows exist at other
		// locales (e.g. an FR post that inherited an EN-only byline via
		// copyContentBylines). Sending `bylines: []` on every save would
		// silently wipe the copied credit. The editor must omit `bylines`
		// from the payload unless the user actually touched the editor.
		it("omits bylines from save payload when the user did not touch the byline editor", async () => {
			const onSave = vi.fn();
			const item = makeItem({ data: { title: "Hello", body: "" } });
			const screen = await renderEditor({ isNew: false, item, onSave });

			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Changed");

			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledTimes(1);
			const payload = onSave.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(payload).not.toHaveProperty("bylines");
		});

		it("suppresses the locale empty-state CTA until the picker query resolves", async () => {
			const item = makeItem({ data: { title: "Hello", body: "" }, locale: "fr-fr" });
			const screen = await renderEditor({
				isNew: false,
				item,
				currentUser: { id: "u-1", role: 50 },
				i18n: { defaultLocale: "en", locales: ["en", "fr-fr"] },
				entryLocale: "fr-fr",
				availableBylines: [],
				availableBylinesLoaded: false,
			});

			await expect
				.element(screen.getByText(/No bylines available/), { timeout: 100 })
				.not.toBeInTheDocument();
		});

		it("shows the locale empty-state CTA once the picker query resolves empty", async () => {
			const item = makeItem({ data: { title: "Hello", body: "" }, locale: "fr-fr" });
			const screen = await renderEditor({
				isNew: false,
				item,
				currentUser: { id: "u-1", role: 50 },
				i18n: { defaultLocale: "en", locales: ["en", "fr-fr"] },
				entryLocale: "fr-fr",
				availableBylines: [],
				availableBylinesLoaded: true,
			});

			await expect.element(screen.getByText(/No bylines available/)).toBeInTheDocument();
		});

		it("includes bylines: [] in save payload for new entries even when untouched", async () => {
			const onSave = vi.fn();
			const screen = await renderEditor({ isNew: true, onSave });

			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Brand new");

			const saveBtn = screen.getByRole("button", { name: "Save" }).first();
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ bylines: [] }));
		});

		it("keeps edited values after autosave completes without queuing another autosave", async () => {
			vi.useFakeTimers();

			try {
				const item = makeItem();
				const onAutosave = vi.fn();
				const props: ContentEditorProps = {
					collection: "posts",
					collectionLabel: "Post",
					fields: defaultFields,
					isNew: false,
					item,
					onSave: vi.fn(),
					onAutosave,
					isAutosaving: false,
					autosaveCompletionToken: 0,
				};

				const screen = await render(<ContentEditor {...props} />);
				const titleInput = screen.getByLabelText("Title");
				await titleInput.fill("Updated title");

				await vi.advanceTimersByTimeAsync(2000);
				expect(onAutosave).toHaveBeenCalledTimes(1);

				await screen.rerender(<ContentEditor {...props} isAutosaving={true} />);
				const autosavedItem = makeItem({
					updatedAt: "2026-04-12T18:38:00Z",
					data: { title: "Updated title", body: "Some content" },
				});
				await screen.rerender(
					<ContentEditor
						{...props}
						item={autosavedItem}
						isAutosaving={false}
						autosaveCompletionToken={1}
					/>,
				);

				await expect.element(screen.getByLabelText("Title")).toHaveValue("Updated title");
				await vi.advanceTimersByTimeAsync(2500);
				expect(onAutosave).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("delete", () => {
		it("shows delete button for existing items", async () => {
			const item = makeItem();
			const onDelete = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onDelete });
			const deleteBtn = screen.getByRole("button", { name: MOVE_TO_TRASH_PATTERN });
			await expect.element(deleteBtn).toBeInTheDocument();
		});

		it("delete button opens confirmation dialog and confirming calls onDelete", async () => {
			const item = makeItem();
			const onDelete = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onDelete });

			// Click the delete trigger button
			const deleteBtn = screen.getByRole("button", { name: MOVE_TO_TRASH_PATTERN });
			await deleteBtn.click();

			// Dialog should appear with "Move to Trash?" title
			await expect.element(screen.getByText("Move to Trash?")).toBeInTheDocument();

			// There are multiple "Move to Trash" buttons - click the last one (the dialog confirm)
			const allBtns = document.querySelectorAll("button");
			const trashBtns = [...allBtns].filter((b) => b.textContent?.trim() === "Move to Trash");
			if (trashBtns[1]) {
				trashBtns[1].click();
			}

			await vi.waitFor(() => {
				expect(onDelete).toHaveBeenCalled();
			});
		});

		it("does not show delete button for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			await expect
				.element(screen.getByText("Move to Trash"), { timeout: 100 })
				.not.toBeInTheDocument();
		});
	});

	describe("publish actions", () => {
		it("uses the elevated surface for the full-bleed canvas and settings panel", async () => {
			await renderEditor({ isNew: false, item: makeItem() });
			const form = document.querySelector("form");
			const provider = document.querySelector<HTMLElement>('[style*="--sidebar-width"]');

			expect(form).toHaveClass("bg-kumo-elevated");
			expect(form).not.toHaveClass("bg-kumo-base");
			expect(provider?.style.getPropertyValue("--sidebar-bg")).toBe("var(--color-kumo-elevated)");
		});

		it("shows Publish button for draft items", async () => {
			const item = makeItem({ status: "draft" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });
			const publishBtn = screen.getByRole("button", { name: "Publish Post", exact: true });
			await expect.element(publishBtn).toBeInTheDocument();
		});

		it("publish button calls onPublish", async () => {
			const item = makeItem({ status: "draft" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });
			const publishBtn = screen.getByRole("button", { name: "Publish Post", exact: true });
			await publishBtn.click();
			expect(onPublish).toHaveBeenCalled();
		});

		it("shows Preview in normal mode when previews are supported", async () => {
			const item = makeItem({ status: "draft" });
			const screen = await renderEditor({ isNew: false, item, supportsPreview: true });
			const previewBtn = screen.getByRole("button", { name: "Preview" });
			await expect.element(previewBtn).toBeInTheDocument();
		});

		it("keeps one publish action reachable below lg", async () => {
			const media = installMatchMedia(true);
			try {
				const item = makeItem({ status: "draft" });
				const screen = await renderEditor({ isNew: false, item, onPublish: vi.fn() });

				await expect.element(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
				await expect.element(screen.getByRole("button", { name: "Save" }).first()).toBeDisabled();
				const publishButtons = screen
					.getByRole("button", { name: "Publish Post", exact: true })
					.all();
				expect(publishButtons).toHaveLength(1);
				await expect.element(publishButtons[0]!).toBeVisible();
			} finally {
				media.restore();
			}
		});

		it("keeps the editor header in the document flow below lg", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({ isNew: false, item: makeItem() });
				const heading = screen.getByRole("heading", { name: "Edit Post" }).element();
				const header = heading.parentElement?.parentElement;

				expect(header).not.toHaveClass("sticky", "top-0", "z-20");
				expect(header).toHaveClass("bg-kumo-elevated/95", "py-3", "backdrop-blur");
			} finally {
				media.restore();
			}
		});

		it("labels and closes the settings sheet below lg", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({ isNew: false, item: makeItem() });

				await screen.getByRole("button", { name: "Settings" }).click();
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.toBeInTheDocument();

				await screen.getByRole("button", { name: "Close settings" }).click();
				await expect
					.element(screen.getByRole("navigation", { name: "Settings" }))
					.not.toBeInTheDocument();
			} finally {
				media.restore();
			}
		});

		it("keeps nested dialogs above the settings sheet and dismisses only the dialog", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({
					isNew: false,
					item: makeItem(),
					onDelete: vi.fn(),
				});

				await screen.getByRole("button", { name: "Settings" }).click();
				await screen.getByRole("button", { name: "Move to Trash" }).click();
				const dialog = screen.getByRole("dialog", { name: "Move to Trash?" });
				await expect.element(dialog).toBeVisible();
				expect(dialog.element().closest<HTMLElement>("[data-base-ui-portal]")?.style.zIndex).toBe(
					"60",
				);

				await vi.waitFor(() => {
					const sheet = document.querySelector('nav[data-sidebar="sidebar"][data-mobile="true"]');
					expect(sheet?.getAttribute("data-state")).toBe("expanded");
				});

				await userEvent.keyboard("{Escape}");
				await expect.element(dialog).not.toBeInTheDocument();
				await vi.waitFor(() => {
					const sheet = document.querySelector('nav[data-sidebar="sidebar"][data-mobile="true"]');
					expect(sheet?.getAttribute("data-state")).toBe("expanded");
				});
			} finally {
				media.restore();
			}
		});

		it("keeps nested tooltips above the settings sheet below lg", async () => {
			const media = installMatchMedia(true);
			try {
				const screen = await renderEditor({
					isNew: false,
					item: makeItem(),
					hasSeo: true,
					onSeoChange: vi.fn(),
				});

				await screen.getByRole("button", { name: "Settings" }).click();
				await userEvent.hover(
					screen
						.getByRole("button", { name: "Why is this important for search result titles?" })
						.element(),
				);

				const tooltip = screen.getByText("Overrides the page title in search engine results");
				await expect.element(tooltip).toBeVisible();
				expect(tooltip.element().closest<HTMLElement>("[data-base-ui-portal]")?.style.zIndex).toBe(
					"60",
				);
			} finally {
				media.restore();
			}
		});

		it("keeps live view and unpublish reachable below lg", async () => {
			const media = installMatchMedia(true);
			try {
				const item = makeItem({
					status: "published",
					liveRevisionId: "rev-1",
					draftRevisionId: "rev-1",
				});
				const screen = await renderEditor({
					isNew: false,
					item,
					onUnpublish: vi.fn(),
					supportsDrafts: true,
				});

				await expect.element(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
				await expect.element(screen.getByRole("link", { name: "Live View" })).toBeVisible();
				const unpublishButtons = screen
					.getByRole("button", { name: "Unpublish Post", exact: true })
					.all();
				expect(unpublishButtons).toHaveLength(1);
				await expect.element(unpublishButtons[0]!).toBeVisible();
			} finally {
				media.restore();
			}
		});

		it("keeps actions reachable when crossing from mobile to desktop layout", async () => {
			const media = installMatchMedia(true);
			try {
				const item = makeItem({ status: "draft" });
				const screen = await renderEditor({ isNew: false, item, supportsPreview: true });

				await expect.element(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "Preview" }).first())
					.toBeInTheDocument();
				await expect.element(screen.getByRole("button", { name: "Save" }).first()).toBeDisabled();

				media.setMatches(false);
				await expect
					.element(screen.getByRole("button", { name: "Settings" }))
					.not.toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "Publish Post", exact: true }))
					.toBeVisible();
			} finally {
				media.restore();
			}
		});

		it("shows Unpublish for published items with supportsDrafts", async () => {
			const item = makeItem({
				status: "published",
				liveRevisionId: "rev-1",
				draftRevisionId: "rev-1",
			});
			const onUnpublish = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				item,
				onUnpublish,
				supportsDrafts: true,
			});
			const unpublishBtn = screen.getByRole("button", {
				name: "Unpublish Post",
				exact: true,
			});
			await expect.element(unpublishBtn).toBeInTheDocument();
		});

		it("unpublish button calls onUnpublish", async () => {
			const item = makeItem({
				status: "published",
				liveRevisionId: "rev-1",
				draftRevisionId: "rev-1",
			});
			const onUnpublish = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				item,
				onUnpublish,
				supportsDrafts: true,
			});
			const unpublishBtn = screen.getByRole("button", {
				name: "Unpublish Post",
				exact: true,
			});
			await unpublishBtn.click();
			expect(onUnpublish).toHaveBeenCalled();
		});
	});

	describe("distraction-free mode", () => {
		it("keeps the editor canvas and header overlay on the elevated surface", async () => {
			const screen = await renderEditor({ isNew: true });
			const form = document.querySelector("form");

			expect(form).toHaveClass("bg-kumo-elevated");
			expect(form).not.toHaveClass("bg-kumo-base");

			await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();

			const heading = screen.getByRole("heading", { name: "New Post" }).element();
			const header = heading.parentElement?.parentElement;
			expect(form).toHaveClass("bg-kumo-elevated");
			expect(header).toHaveClass("bg-kumo-elevated/95");
		});

		it("toggle adds fixed class for distraction-free mode", async () => {
			const screen = await renderEditor({ isNew: true });
			const enterBtn = screen.getByRole("button", { name: "Enter distraction-free mode" });
			await enterBtn.click();

			// The form should now have the fixed inset-0 class
			const form = document.querySelector("form");
			expect(form?.classList.toString()).toContain("fixed");
		});

		it("escape exits distraction-free mode", async () => {
			const screen = await renderEditor({ isNew: true });
			const enterBtn = screen.getByRole("button", { name: "Enter distraction-free mode" });
			await enterBtn.click();

			// Verify we're in distraction-free mode
			let form = document.querySelector("form");
			expect(form?.classList.toString()).toContain("fixed");

			// Press Escape
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

			// Wait for the state to update
			await vi.waitFor(() => {
				form = document.querySelector("form");
				expect(form?.classList.toString()).not.toContain("fixed");
			});
		});

		it("keeps Live View available in distraction-free mode", async () => {
			const item = makeItem({
				status: "published",
				liveRevisionId: "rev-1",
				draftRevisionId: "rev-1",
			});
			const screen = await renderEditor({ isNew: false, item, supportsDrafts: true });

			await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();

			// The settings panel stays mounted while hidden, so the overlay adds a
			// second Live View link rather than replacing the panel's copy.
			expect(screen.getByRole("link", { name: "Live View" }).all()).toHaveLength(2);
		});

		it("preserves settings panel state across a distraction-free round trip", async () => {
			// The panel is hidden, not unmounted, in distraction-free mode —
			// otherwise panel-local state (an open scheduler, a typed date)
			// is silently destroyed by the toggle.
			const item = makeItem({ status: "draft" });
			const screen = await renderEditor({ isNew: false, item, onSchedule: vi.fn() });

			await screen.getByRole("button", { name: "Schedule for later" }).click();
			const scheduleInput = screen.getByLabelText("Schedule for");
			await scheduleInput.fill("2026-08-01T10:00");

			await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();
			// Hidden while writing. Stylesheets aren't loaded in vitest browser
			// mode, so assert the class hook (like the other DF tests) rather
			// than computed visibility.
			await vi.waitFor(() => {
				const aside = document.querySelector('aside[data-sidebar="sidebar"]');
				expect(aside?.classList.contains("hidden")).toBe(true);
			});

			await screen.getByRole("button", { name: "Exit distraction-free mode" }).click();
			// …and still open with the typed date after exiting.
			await vi.waitFor(() => {
				const aside = document.querySelector('aside[data-sidebar="sidebar"]');
				expect(aside?.classList.contains("hidden")).toBe(false);
			});
			await expect.element(screen.getByLabelText("Schedule for")).toHaveValue("2026-08-01T10:00");
		});
	});

	describe("scheduler", () => {
		it("shows scheduler when Schedule for later is clicked", async () => {
			const item = makeItem({ status: "draft" });
			const onSchedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onSchedule });

			const scheduleBtn = screen.getByRole("button", { name: "Schedule for later" });
			await scheduleBtn.click();

			// Should now show the datetime input
			await expect.element(screen.getByLabelText("Schedule for")).toBeInTheDocument();
			// And a Schedule submit button
			await expect.element(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
		});

		it("shows Publish button for scheduled items", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });

			const publishBtn = screen.getByRole("button", { name: "Publish Post", exact: true });
			await expect.element(publishBtn).toBeInTheDocument();
		});

		it("publish button on scheduled item calls onPublish", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });

			const publishBtn = screen.getByRole("button", { name: "Publish Post", exact: true });
			await publishBtn.click();
			expect(onPublish).toHaveBeenCalled();
		});

		it("shows Unschedule button in sidebar for scheduled items", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onUnschedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onUnschedule });

			// Unschedule should be in the sidebar, not in the header
			const unscheduleBtn = screen.getByRole("button", { name: "Unschedule" });
			await expect.element(unscheduleBtn).toBeInTheDocument();
		});

		it("unschedule button calls onUnschedule", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onUnschedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onUnschedule });

			const unscheduleBtn = screen.getByRole("button", { name: "Unschedule" });
			await unscheduleBtn.click();
			expect(onUnschedule).toHaveBeenCalled();
		});
	});

	describe("heading", () => {
		it("preserves configured collection label casing", async () => {
			const item = makeItem();
			const screen = await renderEditor({ isNew: false, item, collectionLabel: "API Docs" });

			await expect
				.element(screen.getByRole("heading", { name: "Edit API Docs", exact: true }))
				.toBeInTheDocument();
		});

		it("shows a quiet heading for new items", async () => {
			const screen = await renderEditor({ isNew: true, collectionLabel: "Post" });
			const heading = screen.getByRole("heading", { name: "New Post" });

			await expect.element(heading).toBeInTheDocument();
			await expect.element(heading).toHaveClass("text-lg", "font-semibold", "truncate");
			expect(heading.element().parentElement).toHaveClass("min-w-0", "items-center", "gap-3");
		});

		it("shows a quiet heading for existing items", async () => {
			const item = makeItem();
			const screen = await renderEditor({ isNew: false, item, collectionLabel: "Post" });
			const heading = screen.getByRole("heading", { name: "Edit Post" });

			await expect.element(heading).toBeInTheDocument();
			await expect.element(heading).toHaveClass("text-lg", "font-semibold", "truncate");
		});
	});

	// ---------------------------------------------------------------------------
	// Bug: translation switch leaves stale content in PortableTextEditor.
	//
	// When navigating between translations of the same content (e.g. /en post ->
	// /fr post), TanStack Router keeps ContentEditor mounted and only the `item`
	// prop changes. The PortableTextEditor (TipTap) freezes its content via
	// useMemo([], ...) on mount and has no effect to reconcile incoming `value`
	// changes, so it keeps showing the previous locale's body.
	//
	// Worse: any subsequent edit fires onUpdate with the stale content, silently
	// overwriting the new translation's body in formData.
	//
	// Fix: key <FieldRenderer> by `${name}:${item?.id ?? "new"}` so all field
	// editors remount cleanly when the underlying content item changes.
	// ---------------------------------------------------------------------------
	describe("translation / item switch", () => {
		function buildPtItem(id: string, text: string): ContentItem {
			return makeItem({
				id,
				slug: id,
				data: {
					title: text,
					body: [
						{
							_type: "block",
							_key: `block-${id}`,
							style: "normal",
							children: [{ _type: "span", _key: `span-${id}`, text, marks: [] }],
							markDefs: [],
						},
					],
				},
			});
		}

		const ptFields: Record<string, FieldDescriptor> = {
			title: { kind: "string", label: "Title", required: true },
			body: { kind: "portableText", label: "Body" },
		};

		it("remounts the portable text editor when item.id changes (translation switch)", async () => {
			const itemEn = buildPtItem("post-en", "English body");
			const itemFr = buildPtItem("post-fr", "French body");

			// Use a wrapper so we can swap items without unmounting ContentEditor.
			function Switcher({ item }: { item: ContentItem }) {
				return (
					<ContentEditor
						collection="posts"
						collectionLabel="Post"
						fields={ptFields}
						isNew={false}
						item={item}
						onSave={vi.fn()}
					/>
				);
			}

			const screen = await render(<Switcher item={itemEn} />);

			// Initial mount: editor shows the English body.
			const editor = screen.getByTestId("portable-text-editor");
			await expect.element(editor).toHaveAttribute("data-content", "English body");
			expect(portableTextMountCount).toBe(1);

			// Simulate translation switch by rerendering with a different item id.
			// The fix (keying FieldRenderer by item.id) must force a fresh mount
			// so the editor reads the new locale's body.
			await screen.rerender(<Switcher item={itemFr} />);

			const editorAfter = screen.getByTestId("portable-text-editor");
			await expect.element(editorAfter).toHaveAttribute("data-content", "French body");

			// A new mount means the FieldRenderer was keyed by id and remounted.
			// Without the fix, mountCount stays at 1 and content stays stale.
			expect(portableTextMountCount).toBeGreaterThanOrEqual(2);
		});

		it("wires onEditorReady through for the 'content' field so DocumentOutline tracks remounts", async () => {
			// ContentEditor only wires `onEditorReady` to its `setPortableTextEditor`
			// slot when the field name is exactly "content" (see ContentEditor.tsx,
			// where the conditional onEditorReady prop is set). On a translation
			// switch, the FieldRenderer is keyed by item.id so the editor remounts;
			// the corresponding cleanup call flows through, clearing the stale ref
			// in the parent before the new instance mounts.
			//
			// The actual cleanup behaviour of PortableTextEditor (calling
			// onEditorReady(null) on unmount) is exercised against the real
			// component in tests/editor/PortableTextEditor.test.tsx — this test
			// only verifies that ContentEditor wires the callback in the first place.
			const ptFieldsForContent: Record<string, FieldDescriptor> = {
				title: { kind: "string", label: "Title", required: true },
				// "content" is the magic field name that wires onEditorReady through
				// to ContentEditor's setPortableTextEditor (see ContentEditor.tsx).
				content: { kind: "portableText", label: "Body" },
			};

			const itemEn = makeItem({
				id: "post-en",
				slug: "post-en",
				data: {
					title: "EN",
					content: [
						{
							_type: "block",
							_key: "block-en",
							style: "normal",
							children: [{ _type: "span", _key: "span-en", text: "English", marks: [] }],
							markDefs: [],
						},
					],
				},
			});
			const itemFr = makeItem({
				id: "post-fr",
				slug: "post-fr",
				data: {
					title: "FR",
					content: [
						{
							_type: "block",
							_key: "block-fr",
							style: "normal",
							children: [{ _type: "span", _key: "span-fr", text: "French", marks: [] }],
							markDefs: [],
						},
					],
				},
			});

			function Switcher({ item }: { item: ContentItem }) {
				return (
					<ContentEditor
						collection="posts"
						collectionLabel="Post"
						fields={ptFieldsForContent}
						isNew={false}
						item={item}
						onSave={vi.fn()}
					/>
				);
			}

			const screen = await render(<Switcher item={itemEn} />);
			await expect
				.element(screen.getByTestId("portable-text-editor"))
				.toHaveAttribute("data-content", "English");

			// Initial mount fired exactly one onEditorReady call with a non-null editor.
			expect(onEditorReadyCalls).toHaveLength(1);
			expect(onEditorReadyCalls[0]?.mockId).not.toBeNull();

			await screen.rerender(<Switcher item={itemFr} />);
			await expect
				.element(screen.getByTestId("portable-text-editor"))
				.toHaveAttribute("data-content", "French");

			// After the switch we expect the call sequence:
			//   1. mount (en) -> non-null
			//   2. cleanup (en) -> null   <-- the M1 fix
			//   3. mount (fr) -> non-null
			// Without the cleanup in PortableTextEditor's onEditorReady effect,
			// step 2 is missing and the stale en-editor reference lingers in
			// ContentEditor's state during the remount window.
			const nullCallIndex = onEditorReadyCalls.findIndex((c) => c.mockId === null);
			expect(nullCallIndex).toBeGreaterThan(-1);

			// The null call must come before the final mount (otherwise the slot
			// would end up null after a fresh editor was reported ready).
			const lastCall = onEditorReadyCalls.at(-1);
			expect(lastCall?.mockId).not.toBeNull();
			expect(nullCallIndex).toBeLessThan(onEditorReadyCalls.length - 1);
		});
	});

	// ---------------------------------------------------------------------------
	// Bug #1217: the byline picker was a plain Select over the first 100 bylines
	// with no search, so bylines beyond the initial page were unreachable, and a
	// credited byline outside that page failed to render at all. The picker now
	// searches the server and resolves credited bylines from the saved entry.
	// ---------------------------------------------------------------------------
	describe("byline picker search (#1217)", () => {
		it("searches the server and adds a byline from outside the initial list", async () => {
			vi.mocked(fetchBylines).mockResolvedValue({
				items: [makeByline({ id: "b-far", slug: "zoe-far", displayName: "Zoe Far" })],
				nextCursor: null,
			});

			const item = makeItem({ data: { title: "Hello", body: "" } });
			const screen = await renderEditor({
				isNew: false,
				item,
				currentUser: { id: "u-1", role: 50 },
				// Empty initial list: the only way to reach "Zoe Far" is via search.
				availableBylines: [],
				availableBylinesLoaded: true,
			});

			const searchInput = screen.getByLabelText("Search bylines");
			await searchInput.fill("Zoe");

			// The debounced server search surfaces the result.
			await expect.element(screen.getByText("Zoe Far")).toBeInTheDocument();
			await vi.waitFor(() => {
				expect(vi.mocked(fetchBylines)).toHaveBeenCalledWith(
					expect.objectContaining({ search: "Zoe" }),
				);
			});

			// Clicking the result credits the byline; it now renders with its
			// Role label editor and leaves the results list.
			await screen.getByRole("button", { name: /Zoe Far/ }).click();
			await expect.element(screen.getByLabelText("Role label")).toBeInTheDocument();
		});

		it("renders a credited byline that is not in the initial picker list", async () => {
			const credited = makeByline({ id: "b-100plus", slug: "ada", displayName: "Ada Lovelace" });
			const item = makeItem({
				data: { title: "Hello", body: "" },
				bylines: [{ byline: credited, sortOrder: 0, roleLabel: "Author" }],
			});

			const screen = await renderEditor({
				isNew: false,
				item,
				currentUser: { id: "u-1", role: 50 },
				// Initial list does NOT include the credited byline (it would be
				// past the old 100-row cap). It must still render from the entry.
				availableBylines: [],
				availableBylinesLoaded: true,
			});

			await expect.element(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		});
	});
});
