/**
 * Admin extension slots — rendered behaviour of both host surfaces.
 *
 * Mounts the real ContentList and ContentSettingsPanel with contributions
 * delivered through PluginAdminProvider (the same seam the trusted native
 * registry uses in production) and pins: header/cell placement, zero-
 * extension markup parity, collection/role filtering leaving no gaps,
 * per-contribution fault isolation, typed context correctness, the batched
 * (no per-row waterfall) data pattern, and that nothing outside the typed
 * trusted registry can reach these slots.
 *
 * Selection semantics (ordering, duplicates, predicates) are covered in
 * tests/lib/admin-extensions.test.ts.
 */

import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ContentList } from "../../src/components/ContentList";
import {
	ContentSettingsPanel,
	type ContentSettingsPanelProps,
} from "../../src/components/ContentSettingsPanel";
import type {
	ContentEditorPanelContext,
	ContentListColumnCellContext,
} from "../../src/lib/admin-extensions";
import type { ContentItem } from "../../src/lib/api";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import { render } from "../utils/render.tsx";

// Same child stubs as ContentSettingsPanel.test.tsx: panel tests assert
// section composition, not child behaviour.
vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div data-testid="taxonomy-sidebar">Taxonomy</div>,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => <div data-testid="doc-outline">Outline</div>,
}));

vi.mock("../../src/components/editor/ImageDetailPanel", () => ({
	ImageDetailPanel: () => <div data-testid="image-detail-panel">Image details</div>,
}));

vi.mock("../../src/components/SeoPanel", () => ({
	SeoPanel: () => <div data-testid="seo-panel">SEO fields</div>,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useNavigate: () => vi.fn(),
		Link: ({
			children,
			to,
			params: _params,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

// ContentList resolves the current user's role itself; make it deterministic
// and controllable per test (no network in browser mode).
const currentUserState = vi.hoisted(() => ({ role: 50 }));

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({
		data: { id: "u1", email: "admin@example.com", role: currentUserState.role },
	}),
}));

// Both hosts skip contributions from plugins disabled in the runtime
// manifest; control that state per test without a network round-trip.
const manifestState = vi.hoisted(() => ({ disabledPluginIds: [] as string[] }));

vi.mock("../../src/lib/api/manifest", () => ({
	useDisabledPluginIds: () => new Set(manifestState.disabledPluginIds),
}));

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		locale: "en",
		translationGroup: null,
		data: { title: "My Post" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

function withPlugins(pluginAdmins: PluginAdmins) {
	return function PluginWrapper({ children }: React.PropsWithChildren) {
		return <PluginAdminProvider pluginAdmins={pluginAdmins}>{children}</PluginAdminProvider>;
	};
}

const listProps = {
	collection: "posts",
	collectionLabel: "Posts",
};

function headerTexts(container: Element): string[] {
	return Array.from(container.querySelectorAll("thead th"), (th) => th.textContent?.trim() ?? "");
}

const CLASSIC_HEADERS = ["Title", "Status", "Date", "Actions"];

function panelProps(overrides: Partial<ContentSettingsPanelProps> = {}): ContentSettingsPanelProps {
	return {
		collection: "posts",
		item: makeItem(),
		isNew: false,
		slug: "my-post",
		onSlugChange: vi.fn(),
		status: "draft",
		supportsDrafts: true,
		isLive: false,
		hasPendingChanges: false,
		hasSchedule: false,
		supportsRevisions: true,
		canSchedule: false,
		onDelete: vi.fn(),
		currentUser: { id: "u1", role: 40 },
		users: [],
		onAuthorChange: vi.fn(),
		activeBylines: [],
		availableBylines: [],
		availableBylinesLoaded: true,
		onBylinesChange: vi.fn(),
		translations: [],
		onTranslate: vi.fn(),
		hasSeo: true,
		onSeoChange: vi.fn(),
		portableTextEditor: {} as Editor,
		blockSidebarPanel: null,
		onBlockSidebarClose: vi.fn(),
		onBlockSidebarDelete: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	currentUserState.role = 50;
	manifestState.disabledPluginIds = [];
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ContentList extension columns", () => {
	it("renders the contributed header between Date and Actions with one cell per row", async () => {
		const registry: PluginAdmins = {
			scorer: {
				contentListColumns: [
					{
						id: "scorer:score",
						label: "Score",
						cell: ({ item }: ContentListColumnCellContext) => <span>score-{item.id}</span>,
					},
				],
			},
		};
		const items = [makeItem({ id: "a1" }), makeItem({ id: "a2", data: { title: "Second" } })];
		const screen = await render(<ContentList {...listProps} items={items} />, {
			wrapper: withPlugins(registry),
		});

		await expect.element(screen.getByText("score-a1")).toBeInTheDocument();
		await expect.element(screen.getByText("score-a2")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual(["Title", "Status", "Date", "Score", "Actions"]);
		// The contributed header is a real column header cell.
		const scoreTh = [...screen.container.querySelectorAll("thead th")].find(
			(th) => th.textContent === "Score",
		);
		expect(scoreTh?.getAttribute("scope")).toBe("col");
	});

	it("orders columns from multiple plugins deterministically", async () => {
		const cell = () => <span />;
		const registry: PluginAdmins = {
			zeta: { contentListColumns: [{ id: "zeta:first", label: "First", order: -1, cell }] },
			alpha: { contentListColumns: [{ id: "alpha:second", label: "Second", order: 2, cell }] },
		};
		const screen = await render(<ContentList {...listProps} items={[makeItem()]} />, {
			wrapper: withPlugins(registry),
		});

		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual([
			"Title",
			"Status",
			"Date",
			"First",
			"Second",
			"Actions",
		]);
	});

	it("keeps the classic markup byte-identical in spirit when no extensions are registered", async () => {
		const screen = await render(<ContentList {...listProps} items={[makeItem()]} />, {
			wrapper: withPlugins({}),
		});
		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual(CLASSIC_HEADERS);
		expect(screen.container.querySelectorAll("tbody tr td").length).toBe(CLASSIC_HEADERS.length);
	});

	it("leaves no header, cell, or gap for inapplicable or role-gated columns", async () => {
		currentUserState.role = 40;
		const cell = () => <span>should-not-render</span>;
		const registry: PluginAdmins = {
			p: {
				contentListColumns: [
					{ id: "p:other-collection", label: "Elsewhere", collections: ["pages"], cell },
					{ id: "p:admins-only", label: "Admins", minRole: 50, cell },
				],
			},
		};
		const screen = await render(<ContentList {...listProps} items={[makeItem()]} />, {
			wrapper: withPlugins(registry),
		});

		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual(CLASSIC_HEADERS);
		expect(screen.getByText("should-not-render").query()).toBeNull();
		expect(screen.container.querySelectorAll("tbody tr td").length).toBe(CLASSIC_HEADERS.length);
	});

	it("isolates a throwing cell to a quiet placeholder without breaking the row", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const registry: PluginAdmins = {
			p: {
				contentListColumns: [
					{
						id: "p:broken",
						label: "Broken",
						cell: () => {
							throw new Error("cell exploded");
						},
					},
					{
						id: "p:healthy",
						label: "Healthy",
						order: 1,
						cell: ({ item }: ContentListColumnCellContext) => <span>ok-{item.id}</span>,
					},
				],
			},
		};
		const screen = await render(<ContentList {...listProps} items={[makeItem({ id: "b1" })]} />, {
			wrapper: withPlugins(registry),
		});

		// The row itself and the healthy contribution survive.
		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		await expect.element(screen.getByText("ok-b1")).toBeInTheDocument();
		// Table structure is preserved: header still announced, cell shows the
		// accessible placeholder instead of collapsing.
		expect(headerTexts(screen.container)).toEqual([
			"Title",
			"Status",
			"Date",
			"Broken",
			"Healthy",
			"Actions",
		]);
		await expect.element(screen.getByText("Extension failed to render")).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalled();
		// The failure never leaks the error message into the UI.
		expect(screen.container.textContent).not.toContain("cell exploded");
	});

	it("passes the typed read-only row context (collection, locale, saved item)", async () => {
		const registry: PluginAdmins = {
			p: {
				contentListColumns: [
					{
						id: "p:ctx",
						label: "Ctx",
						cell: ({ collection, locale, item }: ContentListColumnCellContext) => (
							<span>{`ctx:${collection}:${item.id}:${locale ?? "none"}:${String(item.data.title)}`}</span>
						),
					},
				],
			},
		};
		const screen = await render(
			<ContentList {...listProps} items={[makeItem({ id: "c1" })]} activeLocale="ar" />,
			{ wrapper: withPlugins(registry) },
		);

		await expect.element(screen.getByText("ctx:posts:c1:ar:My Post")).toBeInTheDocument();
	});

	it("shares one batched request across every cell instead of one per row", async () => {
		const batchedFetch = vi.fn(async () => ({ value: "batched" }));
		function BatchedCell({ collection }: ContentListColumnCellContext) {
			// The documented pattern: one query key for the whole column;
			// react-query hands every cell the same in-flight promise.
			const { data } = useQuery({
				queryKey: ["ext-batch", collection],
				queryFn: batchedFetch,
			});
			return <span>{data ? `batch-${data.value}` : "batch-loading"}</span>;
		}
		const registry: PluginAdmins = {
			p: { contentListColumns: [{ id: "p:batch", label: "Batch", cell: BatchedCell }] },
		};
		const items = [makeItem({ id: "r1" }), makeItem({ id: "r2" }), makeItem({ id: "r3" })];
		const fetchSpy = vi.spyOn(window, "fetch");
		const screen = await render(<ContentList {...listProps} items={items} />, {
			wrapper: withPlugins(registry),
		});

		await vi.waitFor(() => {
			expect(screen.container.textContent).toContain("batch-batched");
		});
		expect(screen.container.querySelectorAll("tbody tr").length).toBe(3);
		// Three rows, one request — and the HOST issued no requests at all.
		expect(batchedFetch).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("ContentSettingsPanel extension panels", () => {
	function ctxPanel({ collection, entry, locale }: ContentEditorPanelContext) {
		return (
			<div data-testid="ext-panel">{`panel:${collection}:${entry.id}:${locale ?? "none"}`}</div>
		);
	}

	it("renders a titled section for saved entries, above the trailing core sections", async () => {
		const registry: PluginAdmins = {
			p: {
				contentEditorPanels: [{ id: "p:insights", title: "Editorial Status", panel: ctxPanel }],
			},
		};
		const screen = await render(<ContentSettingsPanel {...panelProps()} />, {
			wrapper: withPlugins(registry),
		});

		await expect
			.element(screen.getByRole("heading", { name: "Editorial Status" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("panel:posts:item-1:en")).toBeInTheDocument();

		// Deterministic placement: after the SEO section, before the outline —
		// and Move to Trash stays the very last section.
		const root = screen.container.firstElementChild;
		const sections = [...(root?.children ?? [])];
		const seoIndex = sections.findIndex((s) => s.querySelector('[data-testid="seo-panel"]'));
		const extIndex = sections.findIndex((s) => s.querySelector('[data-testid="ext-panel"]'));
		const outlineIndex = sections.findIndex((s) => s.querySelector('[data-testid="doc-outline"]'));
		expect(seoIndex).toBeGreaterThan(-1);
		expect(extIndex).toBe(seoIndex + 1);
		expect(outlineIndex).toBe(extIndex + 1);
		expect(root?.lastElementChild?.textContent).toContain("Move to Trash");
		// Narrow-sidebar guard: the section must not force horizontal overflow.
		expect(sections[extIndex]?.className).toContain("min-w-0");
	});

	it("renders nothing for new (never saved) entries", async () => {
		const registry: PluginAdmins = {
			p: {
				contentEditorPanels: [{ id: "p:insights", title: "Editorial Status", panel: ctxPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...panelProps({ item: null, isNew: true })} />,
			{ wrapper: withPlugins(registry) },
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Editorial Status");
	});

	it("applies role and collection gates with no leftover section chrome", async () => {
		const registry: PluginAdmins = {
			p: {
				contentEditorPanels: [
					{ id: "p:admin-only", title: "Admins Only", minRole: 50, panel: ctxPanel },
					{ id: "p:pages-only", title: "Pages Only", collections: ["pages"], panel: ctxPanel },
				],
			},
		};
		// currentUser prop is role 40 (Editor) — below the 50 gate.
		const screen = await render(<ContentSettingsPanel {...panelProps()} />, {
			wrapper: withPlugins(registry),
		});

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Admins Only");
		expect(screen.container.textContent).not.toContain("Pages Only");
		expect(screen.container.querySelector('[data-testid="ext-panel"]')).toBeNull();
	});

	it("isolates a throwing panel and keeps every other section alive", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const registry: PluginAdmins = {
			p: {
				contentEditorPanels: [
					{
						id: "p:broken",
						title: "Broken Panel",
						panel: () => {
							throw new Error("panel exploded");
						},
					},
					{ id: "p:working", title: "Working Panel", order: 1, panel: ctxPanel },
				],
			},
		};
		const screen = await render(<ContentSettingsPanel {...panelProps()} />, {
			wrapper: withPlugins(registry),
		});

		await expect.element(screen.getByText("This extension failed to render.")).toBeInTheDocument();
		// The retry action carries the panel title (screen-reader-only), so two
		// broken panels never produce indistinguishable "Retry" buttons.
		await expect
			.element(screen.getByRole("button", { name: "Retry Broken Panel" }))
			.toBeInTheDocument();
		// The broken panel's own heading stays identifiable; siblings survive.
		await expect.element(screen.getByRole("heading", { name: "Broken Panel" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("heading", { name: "Working Panel" }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalled();
		expect(screen.container.textContent).not.toContain("panel exploded");
	});
});

describe("trusted-registry boundary", () => {
	it("consumes contributions only from the typed native registry fields", async () => {
		// A sandboxed plugin is never present in pluginAdmins (core rejects
		// `adminEntry` for non-native formats at config time), and manifest
		// metadata offers no React path: anything outside the typed fields
		// is ignored even if smuggled into the registry object.
		const smuggled = {
			p: {
				adminPages: [{ path: "/x", label: "X" }],
				blocks: [{ kind: "html", html: "<script>alert(1)</script>" }],
				columns: [{ id: "p:nope", label: "Nope", cell: () => <span>nope</span> }],
			},
		} as unknown as PluginAdmins;

		const screen = await render(<ContentList {...listProps} items={[makeItem()]} />, {
			wrapper: withPlugins(smuggled),
		});

		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual(CLASSIC_HEADERS);
		expect(screen.container.textContent).not.toContain("nope");
	});

	it("renders the classic list without any provider at all", async () => {
		const screen = await render(<ContentList {...listProps} items={[makeItem()]} />);
		await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		expect(headerTexts(screen.container)).toEqual(CLASSIC_HEADERS);
	});
});

describe("plugin lifecycle", () => {
	it("drops a disabled plugin's columns and panels like every other admin surface", async () => {
		manifestState.disabledPluginIds = ["paused"];
		const registry: PluginAdmins = {
			paused: {
				contentListColumns: [
					{ id: "paused:col", label: "Paused Column", cell: () => <span>paused-cell</span> },
				],
				contentEditorPanels: [
					{ id: "paused:panel", title: "Paused Panel", panel: () => <div>paused-panel</div> },
				],
			},
			running: {
				contentListColumns: [
					{ id: "running:col", label: "Running Column", cell: () => <span>running-cell</span> },
				],
			},
		};

		const list = await render(<ContentList {...listProps} items={[makeItem()]} />, {
			wrapper: withPlugins(registry),
		});
		await expect.element(list.getByText("running-cell")).toBeInTheDocument();
		expect(headerTexts(list.container)).toEqual([
			"Title",
			"Status",
			"Date",
			"Running Column",
			"Actions",
		]);
		expect(list.container.textContent).not.toContain("paused-cell");

		await list.unmount();

		const panel = await render(<ContentSettingsPanel {...panelProps()} />, {
			wrapper: withPlugins(registry),
		});
		await expect.element(panel.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(panel.container.textContent).not.toContain("Paused Panel");
		expect(panel.container.textContent).not.toContain("paused-panel");
	});
});
