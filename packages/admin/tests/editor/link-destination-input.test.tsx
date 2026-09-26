import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import {
	LinkDestinationInput,
	looksLikeUrl,
	type LinkDestinationInputProps,
} from "../../src/components/editor/LinkDestinationInput";
import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import type { AdminManifest, ContentItem } from "../../src/lib/api";
import { apiFetch, fetchContent, fetchManifest } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Mocks — network and heavy components that need Astro context
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api")>();
	return {
		...actual,
		apiFetch: vi.fn(),
		fetchManifest: vi.fn(),
		fetchContent: vi.fn(),
	};
});

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

vi.mock("../../src/components/editor/ImageNode", async () => {
	const { Node } = await import("@tiptap/core");
	const ImageExtension = Node.create({
		name: "image",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				src: { default: null },
				alt: { default: "" },
				link: { default: null },
			};
		},
		parseHTML() {
			return [{ tag: "img[src]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["img", HTMLAttributes];
		},
	});
	return { ImageExtension };
});

vi.mock("../../src/components/editor/PluginBlockNode", async () => {
	const { Node } = await import("@tiptap/core");
	const PluginBlockExtension = Node.create({
		name: "pluginBlock",
		group: "block",
		atom: true,
		parseHTML() {
			return [{ tag: "div[data-plugin-block]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["div", { ...HTMLAttributes, "data-plugin-block": "" }];
		},
	});
	return {
		PluginBlockExtension,
		getEmbedMeta: () => ({ label: "Embed", Icon: () => null }),
		registerPluginBlocks: () => {},
		resolveIcon: () => () => null,
	};
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SearchItem {
	collection: string;
	id: string;
	slug: string | null;
	locale: string;
	title?: string;
}

function makeManifest(
	collections: Record<
		string,
		{ label: string; labelSingular?: string; urlPattern?: string; routable?: boolean }
	>,
	i18n?: AdminManifest["i18n"],
): AdminManifest {
	return { collections, i18n } as unknown as AdminManifest;
}

function mockSearchResponses(published: SearchItem[], drafts: SearchItem[] = []) {
	vi.mocked(apiFetch).mockImplementation((input) => {
		const target =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(target, "http://localhost");
		const items = url.searchParams.get("status") === "draft" ? drafts : published;
		return Promise.resolve(
			new Response(JSON.stringify({ data: { items } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
}

const postsManifest = makeManifest({
	posts: { label: "Posts", labelSingular: "Post", urlPattern: "/blog/{slug}" },
});

const helloPost: SearchItem = {
	collection: "posts",
	id: "post-1",
	slug: "hello-world",
	locale: "en",
	title: "Hello World",
};

/** Uncontrolled harness around the controlled component. */
function Harness(props: Partial<Omit<LinkDestinationInputProps, "value" | "onValueChange">>) {
	const [value, setValue] = React.useState("");
	return (
		<LinkDestinationInput
			value={value}
			onValueChange={setValue}
			onSubmit={() => {}}
			onPick={() => {}}
			onEscape={() => {}}
			{...props}
		/>
	);
}

async function typeQuery(screen: Awaited<ReturnType<typeof render>>, text: string) {
	const locator = screen.getByRole("combobox", { name: "Search or type a URL" });
	await expect.element(locator).toBeVisible();
	const input = locator.element();
	(input as HTMLInputElement).focus();
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	setter.call(input, text);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
	vi.mocked(fetchManifest).mockResolvedValue(postsManifest);
	vi.mocked(fetchContent).mockRejectedValue(new Error("not mocked"));
	vi.mocked(apiFetch).mockReset();
});

// ---------------------------------------------------------------------------
// looksLikeUrl
// ---------------------------------------------------------------------------

describe("looksLikeUrl", () => {
	it("treats schemes, paths, anchors, and domains as URLs", () => {
		for (const url of [
			"https://example.com",
			"http://example.com/page",
			"mailto:hi@example.com",
			"tel:+41791234567",
			"/blog/hello",
			"#section",
			"?page=2",
			"example.com",
			"www.example.com/path",
		]) {
			expect(looksLikeUrl(url), url).toBe(true);
		}
	});

	it("treats plain text as a search query", () => {
		for (const text of ["hello", "hello world", "emdash 0.38 release", "St. Gallen news"]) {
			expect(looksLikeUrl(text), text).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// LinkDestinationInput component
// ---------------------------------------------------------------------------

describe("LinkDestinationInput", () => {
	it("searches content and picks an entry as a pattern-resolved URL", async () => {
		mockSearchResponses([helloPost]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hello");

		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/blog/hello-world"));
		expect(fetchContent).not.toHaveBeenCalled();
	});

	it("does not search when the text looks like a URL", async () => {
		mockSearchResponses([helloPost]);
		const screen = await render(<Harness />);

		await typeQuery(screen, "https://example.com");
		// Debounce is 300ms; give the query time to (not) fire.
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(apiFetch).not.toHaveBeenCalled();
		expect(screen.getByRole("option").elements()).toHaveLength(0);
	});

	it("picks the pre-highlighted first result on Enter", async () => {
		mockSearchResponses([helloPost]);
		const onSubmit = vi.fn();
		const onPick = vi.fn();
		const screen = await render(<Harness onSubmit={onSubmit} onPick={onPick} />);

		await typeQuery(screen, "hello");
		await expect.element(screen.getByRole("option", { name: /Hello World/ })).toBeVisible();
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/blog/hello-world"));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("searches domain-like text but keeps Enter on the raw URL", async () => {
		mockSearchResponses([
			{ collection: "posts", id: "post-5", slug: "vue-js", locale: "en", title: "Vue.js Guide" },
		]);
		const onSubmit = vi.fn();
		const onPick = vi.fn();
		const screen = await render(<Harness onSubmit={onSubmit} onPick={onPick} />);

		await typeQuery(screen, "vue.js");
		const option = screen.getByRole("option", { name: /Vue\.js Guide/ });
		await expect.element(option).toBeVisible();

		const input = screen.getByRole("combobox", { name: "Search or type a URL" }).element();
		expect(input.getAttribute("aria-activedescendant")).toBeNull();
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onPick).not.toHaveBeenCalled();
	});

	it("picks a result for domain-like text after arrowing into the list", async () => {
		mockSearchResponses([
			{ collection: "posts", id: "post-5", slug: "vue-js", locale: "en", title: "Vue.js Guide" },
		]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "vue.js");
		await expect.element(screen.getByRole("option", { name: /Vue\.js Guide/ })).toBeVisible();

		await userEvent.keyboard("{ArrowDown}");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/blog/vue-js"));
	});

	it("submits typed URLs on Enter without searching", async () => {
		mockSearchResponses([helloPost]);
		const onSubmit = vi.fn();
		const onPick = vi.fn();
		const screen = await render(<Harness onSubmit={onSubmit} onPick={onPick} />);

		await typeQuery(screen, "/blog/manual");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onPick).not.toHaveBeenCalled();
	});

	it("falls back to /{collection}/{slug} when the collection has no urlPattern", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(makeManifest({ posts: { label: "Posts" } }));
		mockSearchResponses([helloPost]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/posts/hello-world"));
	});

	it("prefixes non-default locales when i18n is configured", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(
			makeManifest(
				{ posts: { label: "Posts", urlPattern: "/blog/{slug}" } },
				{ defaultLocale: "en", locales: ["en", "de"] },
			),
		);
		mockSearchResponses([
			{ collection: "posts", id: "post-2", slug: "hallo-welt", locale: "de", title: "Hallo Welt" },
		]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hallo");
		const option = screen.getByRole("option", { name: /Hallo Welt/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/de/blog/hallo-welt"));
	});

	it("fetches the entry to resolve date tokens in the pattern", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(
			makeManifest({ posts: { label: "Posts", urlPattern: "/blog/{year}/{month}/{slug}" } }),
		);
		vi.mocked(fetchContent).mockResolvedValue({
			status: "published",
			publishedAt: "2026-03-05T10:00:00.000Z",
		} as ContentItem);
		mockSearchResponses([helloPost]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/blog/2026/03/hello-world"));
		expect(fetchContent).toHaveBeenCalledWith("posts", "post-1", { locale: "en" });
	});

	it("refuses to link an entry whose date-token URL cannot be resolved", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(
			makeManifest({ posts: { label: "Posts", urlPattern: "/blog/{year}/{month}/{slug}" } }),
		);
		vi.mocked(fetchContent).mockResolvedValue({
			status: "draft",
			publishedAt: null,
		} as unknown as ContentItem);
		mockSearchResponses([], [helloPost]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await expect.element(screen.getByText(/no URL until it is published/)).toBeVisible();
		expect(onPick).not.toHaveBeenCalled();
	});

	it("refuses a date-token draft even when it still carries a publish date", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(
			makeManifest({ posts: { label: "Posts", urlPattern: "/blog/{year}/{month}/{slug}" } }),
		);
		vi.mocked(fetchContent).mockResolvedValue({
			status: "draft",
			publishedAt: "2025-01-01T00:00:00.000Z",
		} as ContentItem);
		mockSearchResponses([], [helloPost]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await expect.element(screen.getByText(/no URL until it is published/)).toBeVisible();
		expect(onPick).not.toHaveBeenCalled();
	});

	it("shows an error state when the search request fails", async () => {
		vi.mocked(apiFetch).mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const screen = await render(<Harness />);

		await typeQuery(screen, "hello");

		await expect.element(screen.getByText(/Search failed/)).toBeVisible();
		expect(screen.getByRole("option").elements()).toHaveLength(0);
	});

	it("deduplicates the draft bucket and marks drafts", async () => {
		const draftOnly: SearchItem = {
			collection: "posts",
			id: "post-3",
			slug: "upcoming",
			locale: "en",
			title: "Upcoming",
		};
		mockSearchResponses([helloPost], [helloPost, draftOnly]);
		const screen = await render(<Harness />);

		await typeQuery(screen, "post");

		await expect.element(screen.getByRole("option", { name: /Upcoming/ })).toBeVisible();
		const options = screen.getByRole("option").elements();
		expect(options).toHaveLength(2);
		expect(options[0]!.textContent).not.toContain("Draft");
		expect(options[1]!.textContent).toContain("Draft");
	});

	it("hides entries from non-routable collections", async () => {
		vi.mocked(fetchManifest).mockResolvedValue(
			makeManifest({
				posts: { label: "Posts", urlPattern: "/blog/{slug}" },
				snippets: { label: "Snippets", routable: false },
			}),
		);
		mockSearchResponses([
			helloPost,
			{ collection: "snippets", id: "snip-1", slug: "footer", locale: "en", title: "Footer" },
		]);
		const screen = await render(<Harness />);

		await typeQuery(screen, "foo");

		await expect.element(screen.getByRole("option", { name: /Hello World/ })).toBeVisible();
		expect(screen.getByRole("option").elements()).toHaveLength(1);
	});

	it("supports keyboard selection with arrow keys and Enter", async () => {
		const second: SearchItem = {
			collection: "posts",
			id: "post-4",
			slug: "second",
			locale: "en",
			title: "Second Post",
		};
		mockSearchResponses([helloPost, second]);
		const onPick = vi.fn();
		const screen = await render(<Harness onPick={onPick} />);

		await typeQuery(screen, "post");
		await expect.element(screen.getByRole("option", { name: /Second Post/ })).toBeVisible();

		await userEvent.keyboard("{ArrowDown}");
		await userEvent.keyboard("{ArrowDown}");
		await vi.waitFor(() => {
			const input = screen.getByRole("combobox", { name: "Search or type a URL" }).element();
			expect(input.getAttribute("aria-activedescendant")).toMatch(/-1$/);
		});
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("/blog/second"));
	});

	it("shows an empty state when nothing matches", async () => {
		mockSearchResponses([]);
		const screen = await render(<Harness />);

		await typeQuery(screen, "nothing");

		await expect.element(screen.getByText("No matching content found.")).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Editor integration
// ---------------------------------------------------------------------------

const defaultValue = [
	{
		_type: "block" as const,
		_key: "1",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s1", text: "Hello world" }],
	},
];

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editorInstance: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			value={defaultValue}
			onEditorReady={(editor) => {
				editorInstance = editor;
			}}
			{...props}
		/>,
	);

	await vi.waitFor(
		() => {
			expect(document.querySelector(".ProseMirror")).toBeTruthy();
			expect(editorInstance).toBeTruthy();
		},
		{ timeout: 3000 },
	);

	const pm = document.querySelector(".ProseMirror") as HTMLElement;
	return { screen, editor: editorInstance!, pm };
}

async function focusAndSelectAll(editor: Editor, pm: HTMLElement) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
	editor.commands.focus();
	editor.commands.selectAll();
}

/** Insert an image and select it, which is a NodeSelection rather than a text selection. */
async function insertAndSelectImage(
	editor: Editor,
	pm: HTMLElement,
	link: { href: string; blank?: boolean } | null = null,
) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
	editor
		.chain()
		.focus()
		.insertContent({ type: "image", attrs: { src: "/img.jpg", alt: "Example", link } })
		.run();

	let imagePos = -1;
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "image") {
			imagePos = pos;
			return false;
		}
		return true;
	});
	expect(imagePos).toBeGreaterThanOrEqual(0);
	editor.view.dispatch(
		editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imagePos)),
	);
	await vi.waitFor(() => expect(editor.isActive("image")).toBe(true));
}

describe("link destination input in the editor", () => {
	it("inserts a picked entry as a link from the toolbar popover", async () => {
		mockSearchResponses([helloPost]);
		const { screen, editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
			expect(editor.getAttributes("link").href).toBe("/blog/hello-world");
		});
	});

	it("points a selected image at a picked entry instead of marking text", async () => {
		mockSearchResponses([helloPost]);
		const { screen, editor, pm } = await renderEditor();
		await insertAndSelectImage(editor, pm);

		screen.getByRole("button", { name: "Image link", exact: true }).element().click();

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => {
			expect(editor.getAttributes("image").link).toEqual({ href: "/blog/hello-world" });
		});
		// The destination belongs to the image, not to a text link mark.
		expect(editor.isActive("link")).toBe(false);
	});

	it("keeps a selected image's open-in-new-tab choice when a picked entry replaces its link", async () => {
		mockSearchResponses([helloPost]);
		const { screen, editor, pm } = await renderEditor();
		await insertAndSelectImage(editor, pm, { href: "/old", blank: true });

		screen.getByRole("button", { name: "Image link", exact: true }).element().click();

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => {
			expect(editor.getAttributes("image").link).toEqual({
				href: "/blog/hello-world",
				blank: true,
			});
		});
	});

	it("applies typed URLs from the toolbar popover via Apply", async () => {
		mockSearchResponses([]);
		const { screen, editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		screen.getByRole("button", { name: "Insert Link" }).element().click();
		await typeQuery(screen, "https://example.com");
		screen.getByRole("button", { name: "Apply" }).element().click();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
			expect(editor.getAttributes("link").href).toBe("https://example.com");
		});
	});

	it("inserts a picked entry as a link from the bubble menu", async () => {
		mockSearchResponses([helloPost]);
		const { editor, pm, screen } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		let menu: HTMLElement | null = null;
		await vi.waitFor(
			() => {
				menu = document.querySelector<HTMLElement>("[data-emdash-inline-bubble-menu]");
				expect(menu).toBeTruthy();
			},
			{ timeout: 3000 },
		);

		menu!.querySelector<HTMLButtonElement>('[aria-label="Add link"]')!.click();

		await typeQuery(screen, "hello");
		const option = screen.getByRole("option", { name: /Hello World/ });
		await expect.element(option).toBeVisible();
		(option.element() as HTMLElement).click();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
			expect(editor.getAttributes("link").href).toBe("/blog/hello-world");
		});
	});
});
