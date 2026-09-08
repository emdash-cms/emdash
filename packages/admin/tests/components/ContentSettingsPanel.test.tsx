import { i18n } from "@lingui/core";
import { act, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { ContentEditorProps } from "../../src/components/ContentEditor";
import {
	ContentSettingsPanel,
	SettingsActionBar,
	type ContentSettingsPanelProps,
	type SettingsActionBarProps,
} from "../../src/components/ContentSettingsPanel";
import type { BlockSidebarPanel } from "../../src/components/PortableTextEditor";
import type { AdminManifest, BylineSummary, ContentItem } from "../../src/lib/api";
import type { ContentEditorPanelContext } from "../../src/lib/content-editor-panels";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import {
	publishingInstantToLocalFields,
	resolvePublishingLocalDateTime,
} from "../../src/lib/publishing-datetime.js";
import { render } from "../utils/render.tsx";

// Mock child components with their own data fetching so the panel tests
// only assert section visibility, not child behaviour.
vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: ({ canManageTaxonomies }: { canManageTaxonomies: boolean }) => (
		<div data-testid="taxonomy-sidebar" data-can-manage={String(canManageTaxonomies)}>
			Taxonomy
		</div>
	),
	useHasApplicableTaxonomies: () => true,
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
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post" },
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

async function setPublishingTime(
	screen: Awaited<ReturnType<typeof render>>,
	time: `${string}:${string}`,
) {
	const [hour = "", minute = ""] = time.split(":");
	const hour24 = Number(hour);
	const hourCycle = new Intl.DateTimeFormat(i18n.locale, { hour: "numeric" }).resolvedOptions()
		.hourCycle;
	const use12HourClock = hourCycle === "h11" || hourCycle === "h12";
	const displayHour = String(use12HourClock ? hour24 % 12 || 12 : hour24).padStart(2, "0");
	await screen.getByRole("textbox", { name: "Hour" }).fill(displayHour);
	await screen.getByRole("textbox", { name: "Minute" }).fill(minute);
	if (use12HourClock) {
		const periodLabel =
			new Intl.DateTimeFormat(i18n.locale, { hour: "numeric", hour12: true })
				.formatToParts(new Date(2020, 0, 1, hour24))
				.find(({ type }) => type === "dayPeriod")?.value ?? (hour24 >= 12 ? "PM" : "AM");
		const period = screen.getByRole("combobox", { name: "Period" });
		if (!period.element().textContent?.includes(periodLabel)) {
			fireEvent.click(period.element());
			const option = screen.getByRole("option", { name: periodLabel, exact: true });
			await expect.element(option).toBeInTheDocument();
			fireEvent.click(option.element());
		}
	}
}

function displayedHour(time: string): string {
	const hour = Number(time.slice(0, 2));
	const hourCycle = new Intl.DateTimeFormat(i18n.locale, { hour: "numeric" }).resolvedOptions()
		.hourCycle;
	return String(hourCycle === "h11" || hourCycle === "h12" ? hour % 12 || 12 : hour).padStart(
		2,
		"0",
	);
}

function makeByline(): BylineSummary {
	return {
		id: "byline-1",
		slug: "mina-patel",
		displayName: "Mina Patel",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: true,
		createdAt: "2026-08-26T12:00:00Z",
		updatedAt: "2026-08-26T12:00:00Z",
		locale: "en",
		translationGroup: null,
	};
}

const EDITOR_ROLE: NonNullable<ContentEditorProps["currentUser"]> = { id: "u1", role: 40 };
const AUTHOR_ROLE: NonNullable<ContentEditorProps["currentUser"]> = { id: "u2", role: 20 };
const USERS = [
	{ id: "u1", name: "Editor One", email: "editor@example.com", role: 40 },
] as ContentSettingsPanelProps["users"];

const TEST_MANIFEST: AdminManifest = {
	version: "0.30.0",
	hash: "test",
	collections: {},
	plugins: { insights: { enabled: true } },
};

function InsightsPanel({ entry, locale }: ContentEditorPanelContext) {
	return (
		<div data-testid="insights-panel">
			Insights for {entry.slug} ({locale})
		</div>
	);
}

function pluginWrapper(pluginAdmins: PluginAdmins) {
	return function PluginWrapper({ children }: React.PropsWithChildren) {
		return <PluginAdminProvider pluginAdmins={pluginAdmins}>{children}</PluginAdminProvider>;
	};
}

function makePanelProps(
	overrides: Partial<ContentSettingsPanelProps> = {},
): ContentSettingsPanelProps {
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
		supportsRevisions: true,
		canSchedule: false,
		onDelete: vi.fn(),
		currentUser: EDITOR_ROLE,
		users: USERS,
		onAuthorChange: vi.fn(),
		activeBylines: [],
		availableBylines: [],
		availableBylinesLoaded: true,
		onBylinesChange: vi.fn(),
		i18n: { defaultLocale: "en", locales: ["en", "ar"] },
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

describe("ContentSettingsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders all eight sections when every capability is enabled", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Ownership" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Bylines" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Translations" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("taxonomy-sidebar")).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "SEO" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("doc-outline")).toBeInTheDocument();
		await expect.element(screen.getByTestId("revision-history")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
	});

	it("moves byline ordering guidance into help beside the heading", async () => {
		const byline = makeByline();
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					activeBylines: [{ bylineId: byline.id, roleLabel: null }],
					availableBylines: [byline],
				})}
			/>,
		);
		await expect.element(screen.getByRole("button", { name: "Add another byline" })).toBeVisible();
		const trigger = screen.getByRole("button", { name: "Why are bylines shown in this order?" });
		trigger.element().focus();
		await expect.element(screen.getByText("Shown to readers in this order.")).toBeVisible();
	});

	it("omits the redundant lifecycle badge and distinguishes live and draft versions", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						liveRevisionId: "rev-live",
						draftRevisionId: "rev-draft",
					}),
					status: "published",
					isLive: true,
					hasPendingChanges: true,
					onDiscardDraft: vi.fn(),
				})}
			/>,
		);

		expect(screen.getByText("Published", { exact: true }).query()).toBeNull();
		const summary = screen.getByRole("group", { name: "Publishing summary" });
		await expect.element(summary.getByText("Live version", { exact: true })).toBeInTheDocument();
		await expect.element(summary.getByText("Draft changes", { exact: true })).toBeInTheDocument();
		await expect
			.element(summary.getByText("Visitors still see the published version"))
			.toBeInTheDocument();
		await expect
			.element(summary.getByText("Ready to publish now or schedule for later"))
			.toBeInTheDocument();
		expect(screen.getByText("Live", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Ready", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Status", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Pending changes", { exact: true }).query()).toBeNull();
		await expect.element(summary.getByRole("button", { name: "Discard changes" })).toBeVisible();
	});

	it("keeps publication date primary and discloses created and updated dates on request", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						publishedAt: "2025-01-15T10:30:00.000Z",
						liveRevisionId: "rev-live",
						draftRevisionId: "rev-live",
					}),
					status: "published",
					isLive: true,
				})}
			/>,
		);

		await expect.element(screen.getByText("Publication date", { exact: true })).toBeVisible();
		const history = screen.getByRole("button", { name: "Created and updated" });
		await expect.element(history).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByText("Created", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Updated", { exact: true }).query()).toBeNull();

		fireEvent.click(history.element());
		await expect.element(history).toHaveAttribute("aria-expanded", "true");
		await expect.element(screen.getByText("Created", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("Updated", { exact: true })).toBeVisible();
		fireEvent.click(history.element());
		await expect.element(history).toHaveAttribute("aria-expanded", "false");
		await vi.waitFor(() => {
			expect(screen.getByText("Created", { exact: true }).query()).toBeNull();
		});
		history.element().blur();
		await screen.unmount();
	});

	it("only grants inline taxonomy management to editors", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);
		await expect
			.element(screen.getByTestId("taxonomy-sidebar"))
			.toHaveAttribute("data-can-manage", "true");

		await screen.rerender(
			<ContentSettingsPanel {...makePanelProps({ currentUser: AUTHOR_ROLE })} />,
		);
		await expect
			.element(screen.getByTestId("taxonomy-sidebar"))
			.toHaveAttribute("data-can-manage", "false");
	});

	it("shows the stored content locale separately from the admin language", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ locale: "ja" }),
					manifest: {
						...TEST_MANIFEST,
						contentLocale: { defaultLocale: "ja", implicit: false },
					},
				})}
			/>,
		);

		await expect.element(screen.getByText("Content locale")).toBeInTheDocument();
		await expect.element(screen.getByText("JA", { exact: true })).toBeInTheDocument();
		expect(screen.getByText(/stored with the entry and is separate/).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Why English is used" }).query()).toBeNull();
	});

	it("keeps implicit English visible through compact help without a persistent warning", async () => {
		const manifest = { ...TEST_MANIFEST, contentLocale: { defaultLocale: "en", implicit: true } };
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({ item: makeItem({ locale: "en" }), i18n: undefined, manifest })}
			/>,
		);

		await expect.element(screen.getByText("EN", { exact: true })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Why English is used" }).query()).not.toBeNull();
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({ item: null, isNew: true, i18n: undefined, manifest })}
			/>,
		);
		expect(screen.getByText(/stored with the entry and is separate/).query()).toBeNull();
		const trigger = screen.getByRole("button", { name: "Why English is used" });
		await expect.element(screen.getByText("EN", { exact: true })).toBeInTheDocument();
		const explanation =
			"English is used because no content locale is configured. Content locale is stored with the entry and is separate from your admin language.";
		const help = screen.getByText(explanation);
		await userEvent.hover(trigger.element());
		await expect.element(help).toBeVisible();
		await userEvent.hover(document.body);
		await vi.waitFor(() => expect(help.query()).toBeNull());
		trigger.element().focus();
		await expect.element(help).toBeVisible();
		expect(screen.getByRole("alert").query()).toBeNull();
		await userEvent.tab();
		await vi.waitFor(() => expect(help.query()).toBeNull());
	});

	it("shows the scheduled summary without redundant status badges", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ scheduledAt: "2027-06-01T12:00:00.000Z" }),
				})}
			/>,
		);

		await expect
			.element(screen.getByText("First publication", { exact: true }))
			.toBeInTheDocument();
		expect(screen.getByText("Scheduled", { exact: true }).query()).toBeNull();
		await expect.element(screen.getByText(/Scheduled for/)).toBeVisible();
		expect(
			screen.container.querySelector('time[datetime="2027-06-01T12:00:00.000Z"]')?.textContent,
		).toContain("(EDT)");
		expect(screen.container.textContent).not.toContain("Draft");
	});

	it("shows scheduled draft changes while the published version stays live", async () => {
		const scheduledAt = "2027-06-01T12:00:00.000Z";
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						liveRevisionId: "rev-live",
						draftRevisionId: "rev-draft",
						scheduledAt,
					}),
					status: "published",
					isLive: true,
					hasPendingChanges: true,
				})}
			/>,
		);

		await expect.element(screen.getByText("Live version", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("Draft changes", { exact: true })).toBeVisible();
		await expect
			.element(screen.getByText("Visitors see the published version until the scheduled update"))
			.toBeVisible();
		expect(screen.container.querySelector(`time[datetime="${scheduledAt}"]`)).not.toBeNull();
	});

	it("does not claim draft changes for a live item with only a persisted schedule", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						liveRevisionId: "rev-live",
						draftRevisionId: "rev-live",
						scheduledAt: "2027-06-01T12:00:00.000Z",
					}),
					status: "published",
					isLive: true,
				})}
			/>,
		);

		await expect.element(screen.getByText("Live version", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("Scheduled publication", { exact: true })).toBeVisible();
		expect(screen.getByText("Draft changes", { exact: true }).query()).toBeNull();
	});

	it("omits header lifecycle badges when drafts are unsupported", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ status: "published", supportsDrafts: false })} />,
		);
		expect(screen.getByText("Published", { exact: true }).query()).toBeNull();

		await screen.rerender(
			<ContentSettingsPanel {...makePanelProps({ status: "reviewing", supportsDrafts: false })} />,
		);
		expect(screen.getByText("Reviewing", { exact: true }).query()).toBeNull();
	});

	it("shows a persisted schedule without live-and-draft language when drafts are unsupported", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ scheduledAt: "2027-06-01T12:00:00.000Z" }),
					status: "reviewing",
					supportsDrafts: false,
				})}
			/>,
		);

		await expect.element(screen.getByText("Scheduled publication", { exact: true })).toBeVisible();
		expect(screen.getByText("Live version", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Draft version", { exact: true }).query()).toBeNull();
	});

	it("renders applicable trusted plugin panels in host-owned sections", async () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{
						id: "summary",
						title: "Content insights",
						component: InsightsPanel,
						collections: ["posts"],
					},
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					manifest: TEST_MANIFEST,
					entryLocale: "en",
				})}
			/>,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect
			.element(screen.getByRole("heading", { name: "Content insights" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByTestId("insights-panel"))
			.toHaveTextContent("Insights for my-post (en)");
	});

	it("localizes trusted plugin panel titles in host-owned UI", async () => {
		const previousLocale = i18n.locale;
		i18n.load("nl", { "Content insights": "Inhoudsinzichten" });
		i18n.activate("nl");
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{
						id: "summary",
						title: "Content insights",
						component: InsightsPanel,
					},
				],
			},
		};

		try {
			const screen = await render(
				<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
				{ wrapper: pluginWrapper(pluginAdmins) },
			);

			await expect
				.element(screen.getByRole("heading", { name: "Inhoudsinzichten" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Drag to reorder Inhoudsinzichten" }))
				.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("omits panels when their plugin is disabled or the entry is new", async () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "summary", title: "Content insights", component: InsightsPanel },
				],
			},
		};
		const disabledManifest: AdminManifest = {
			...TEST_MANIFEST,
			plugins: { insights: { enabled: false } },
		};
		const disabledScreen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: disabledManifest })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);
		expect(disabledScreen.container.querySelector('[data-testid="insights-panel"]')).toBeNull();

		const newScreen = await render(
			<ContentSettingsPanel
				{...makePanelProps({ item: null, isNew: true, manifest: TEST_MANIFEST })}
			/>,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);
		expect(newScreen.container.querySelector('[data-testid="insights-panel"]')).toBeNull();
	});

	it("contains plugin panel render failures", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		function BrokenPanel(): React.ReactNode {
			throw new Error("render failed");
		}
		function HealthyPanel(): React.ReactNode {
			return <div data-testid="healthy-panel">Healthy panel</div>;
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "broken", title: "Broken insights", component: BrokenPanel },
					{ id: "healthy", title: "Healthy insights", component: HealthyPanel },
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Plugin panel unavailable.");
		await expect.element(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("healthy-panel")).toHaveTextContent("Healthy panel");
		await expect.element(screen.getByTestId("doc-outline")).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalled();
	});

	it("recovers a failed plugin panel when Retry is pressed", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let failPanel: (() => void) | undefined;
		let mountCount = 0;
		function FlakyPanel(): React.ReactNode {
			const [failed, setFailed] = React.useState(false);
			React.useEffect(() => {
				mountCount += 1;
			}, []);
			failPanel = () => setFailed(true);
			if (failed) throw new Error("panel failed");
			return <div data-testid="flaky-panel">Recovered</div>;
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "flaky", title: "Flaky insights", component: FlakyPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("flaky-panel")).toBeInTheDocument();
		await act(async () => failPanel?.());
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Plugin panel unavailable.");

		await screen.getByRole("button", { name: "Retry" }).click();

		await expect.element(screen.getByTestId("flaky-panel")).toBeInTheDocument();
		expect(screen.getByRole("alert").query()).toBeNull();
		expect(mountCount).toBe(2);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("remounts plugin panels when the content identity changes", async () => {
		let nextMount = 0;
		function IdentityPanel({ entry }: ContentEditorPanelContext) {
			const [mount] = React.useState(() => ++nextMount);
			return (
				<div data-testid="identity-panel">
					{entry.id}:mount-{mount}
				</div>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "identity", title: "Identity", component: IdentityPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("identity-panel")).toHaveTextContent("item-1:mount-1");
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-2", slug: "second-post" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);

		await expect.element(screen.getByTestId("identity-panel")).toHaveTextContent("item-2:mount-2");
	});

	it("remounts plugin panels when the collection changes", async () => {
		let nextMount = 0;
		function CollectionPanel({ collection }: ContentEditorPanelContext) {
			const [mount] = React.useState(() => ++nextMount);
			return (
				<div data-testid="collection-panel">
					{collection}:mount-{mount}
				</div>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "collection", title: "Collection", component: CollectionPanel },
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("collection-panel")).toHaveTextContent("posts:mount-1");
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					collection: "pages",
					item: makeItem({ type: "pages" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);

		await expect.element(screen.getByTestId("collection-panel")).toHaveTextContent("pages:mount-2");
	});

	it("resets failed plugin panels when their content context changes", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let nextMount = 0;
		function ContextPanel({ collection, entry }: ContentEditorPanelContext) {
			const [failed, setFailed] = React.useState(false);
			const [mount] = React.useState(() => ++nextMount);
			if (failed) throw new Error("context panel failed");
			return (
				<button type="button" data-testid="context-panel" onClick={() => setFailed(true)}>
					{collection}:{entry.id}:mount-{mount}
				</button>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "context", title: "Context", component: ContextPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("posts:item-1:mount-1");
		await screen.getByTestId("context-panel").click();
		await expect.element(screen.getByRole("alert")).toBeInTheDocument();

		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-2", slug: "second-post" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);
		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("posts:item-2:mount-2");

		await screen.getByTestId("context-panel").click();
		await expect.element(screen.getByRole("alert")).toBeInTheDocument();
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					collection: "pages",
					item: makeItem({ id: "item-2", slug: "second-page", type: "pages" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);
		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("pages:item-2:mount-3");
		expect(errorSpy).toHaveBeenCalled();
	});

	it("hides Ownership and Bylines for users below the editor role", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ currentUser: AUTHOR_ROLE })} />,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Ownership");
		expect(screen.container.textContent).not.toContain("Bylines");
	});

	it("lets editors update the publish date of published content", async () => {
		const onPublishedAtChange = vi.fn();
		const publishedAt = "2025-01-15T10:30:45.123Z";
		const initial = publishingInstantToLocalFields(publishedAt);
		const previousLocale = i18n.locale;
		i18n.load("ar", {});
		i18n.activate("ar");
		try {
			const screen = await render(
				<div dir="rtl">
					<ContentSettingsPanel
						{...makePanelProps({
							item: makeItem({
								status: "published",
								publishedAt,
							}),
							isLive: true,
							onPublishedAtChange,
						})}
					/>
				</div>,
			);

			const trigger = screen.getByRole("button", { name: /Change publication date:/ });
			await expect.element(trigger).toBeVisible();
			expect(screen.container.querySelector('input[type="time"]')).toBeNull();
			await trigger.getByText("Publication date", { exact: true }).click();
			const dialog = screen.getByRole("dialog", { name: "Change publication date" });
			expect(dialog.getByText("Change the recorded date for the live version.").query()).toBeNull();
			expect(dialog.getByText("Date", { exact: true }).query()).toBeNull();
			await expect
				.element(screen.getByRole("textbox", { name: "Hour" }))
				.toHaveValue(displayedHour(initial.time));
			await expect
				.element(screen.getByRole("textbox", { name: "Minute" }))
				.toHaveValue(initial.time.slice(3));
			await expect.element(dialog.getByRole("button", { name: "Save date" })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }).element());
			expect(onPublishedAtChange).not.toHaveBeenCalled();

			await trigger.click();
			await setPublishingTime(screen, "08:45");
			const resolved = resolvePublishingLocalDateTime(initial.date, "08:45");
			expect(resolved.success).toBe(true);
			await userEvent.keyboard("{Enter}");

			expect(onPublishedAtChange).toHaveBeenCalledWith(
				resolved.success ? resolved.value : undefined,
			);
			await expect.element(dialog).not.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("keeps publication-date values available after an update is rejected", async () => {
		const onPublishedAtChange = vi.fn().mockRejectedValue(new Error("Date update failed"));
		const publishedAt = "2025-01-15T10:30:00.000Z";
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ status: "published", publishedAt }),
					isLive: true,
					onPublishedAtChange,
				})}
			/>,
		);

		await screen.getByRole("button", { name: /Change publication date:/ }).click();
		await setPublishingTime(screen, "08:45");
		fireEvent.click(screen.getByRole("button", { name: "Save date" }).element());

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Date update failed");
		await expect.element(screen.getByRole("textbox", { name: "Hour" })).toHaveValue("08");
		await expect.element(screen.getByRole("textbox", { name: "Minute" })).toHaveValue("45");
		expect(onPublishedAtChange).toHaveBeenCalledOnce();
	});

	it("closes and resets the publication-date editor when the entry changes", async () => {
		let rejectUpdate: (reason?: unknown) => void = () => {};
		const pendingUpdate = new Promise<void>((_resolve, reject) => {
			rejectUpdate = reject;
		});
		const onPublishedAtChange = vi.fn(() => pendingUpdate);
		const firstPublishedAt = "2025-01-15T10:30:00.000Z";
		const secondPublishedAt = "2025-02-20T17:15:00.000Z";
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-1", status: "published", publishedAt: firstPublishedAt }),
					isLive: true,
					onPublishedAtChange,
				})}
			/>,
		);

		await screen.getByRole("button", { name: /Change publication date:/ }).click();
		await setPublishingTime(screen, "08:45");
		fireEvent.click(screen.getByRole("button", { name: "Save date" }).element());
		await expect.element(screen.getByRole("button", { name: "Save date" })).toBeDisabled();

		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-2", status: "published", publishedAt: secondPublishedAt }),
					isLive: true,
					onPublishedAtChange,
				})}
			/>,
		);
		await vi.waitFor(() => {
			expect(screen.getByText("Change publication date", { exact: true }).query()).toBeNull();
		});
		await act(async () => {
			rejectUpdate(new Error("Stale update failed"));
			await Promise.resolve();
		});
		expect(screen.getByRole("alert").query()).toBeNull();

		await screen.getByRole("button", { name: /Change publication date:/ }).click();
		const resetTime = publishingInstantToLocalFields(secondPublishedAt).time;
		await expect
			.element(screen.getByRole("textbox", { name: "Hour" }))
			.toHaveValue(displayedHour(resetTime));
		await expect
			.element(screen.getByRole("textbox", { name: "Minute" }))
			.toHaveValue(resetTime.slice(3));
	});

	it("lets editors update a retained publication date while content is unpublished", async () => {
		const onPublishedAtChange = vi.fn();
		const publishedAt = "2025-01-15T10:30:00.000Z";
		const initial = publishingInstantToLocalFields(publishedAt);
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ status: "draft", publishedAt, liveRevisionId: null }),
					isLive: false,
					onPublishedAtChange,
				})}
			/>,
		);

		await screen.getByRole("button", { name: /Change publication date:/ }).click();
		await setPublishingTime(screen, "08:45");
		const resolved = resolvePublishingLocalDateTime(initial.date, "08:45");
		expect(resolved.success).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Save date" }).element());

		expect(onPublishedAtChange).toHaveBeenCalledWith(resolved.success ? resolved.value : undefined);
	});

	it("does not expose publish-date editing below the editor role", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						publishedAt: "2025-01-15T10:30:00.000Z",
					}),
					isLive: true,
					currentUser: AUTHOR_ROLE,
					onPublishedAtChange: vi.fn(),
				})}
			/>,
		);

		await expect.element(screen.getByText("Publication date", { exact: true })).toBeVisible();
		expect(screen.getByRole("button", { name: /Change publication date:/ }).query()).toBeNull();
		expect(screen.container.querySelector('input[type="time"]')).toBeNull();
		const timestamps = screen.getByTestId("content-timestamps").element();
		expect(timestamps.querySelectorAll("time")).toHaveLength(1);
		expect(timestamps.querySelector('time[datetime="2025-01-15T10:30:00.000Z"]')).not.toBeNull();
		await screen.getByRole("button", { name: "Created and updated" }).click();
		expect(timestamps.querySelectorAll("time")).toHaveLength(3);
	});

	it("hides capability-gated sections when their flags are off", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					hasSeo: false,
					supportsRevisions: false,
					portableTextEditor: null,
					i18n: undefined,
				})}
			/>,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.querySelector('[data-testid="seo-panel"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="revision-history"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="doc-outline"]')).toBeNull();
		expect(screen.container.textContent).not.toContain("Translations");
	});

	it("hides item-dependent sections for new entries", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ item: null, isNew: true })} />,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		// No trash, no translations, no taxonomies, no SEO, no revisions for new items
		expect(screen.container.textContent).not.toContain("Move to Trash");
		expect(screen.container.textContent).not.toContain("Translations");
		expect(screen.container.querySelector('[data-testid="taxonomy-sidebar"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="seo-panel"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="revision-history"]')).toBeNull();
	});

	it("does not render an empty publishing summary for a new collection without drafts", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({ item: null, isNew: true, supportsDrafts: false })}
			/>,
		);

		expect(screen.getByRole("group", { name: "Publishing summary" }).query()).toBeNull();
	});

	it("renders the block detail panel instead of settings when a block requests the sidebar", async () => {
		const blockPanel: BlockSidebarPanel = {
			type: "image",
			attrs: {},
			onUpdate: vi.fn(),
			onReplace: vi.fn(),
			onDelete: vi.fn(),
			onClose: vi.fn(),
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ blockSidebarPanel: blockPanel })} />,
		);

		await expect.element(screen.getByTestId("image-detail-panel")).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Publish");
		expect(screen.container.textContent).not.toContain("Move to Trash");
	});

	it("keeps Move to Trash as the last section", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);
		const root = screen.container.firstElementChild;
		const lastSection = root?.lastElementChild;
		expect(lastSection?.textContent).toContain("Move to Trash");
	});

	it("hides destructive actions without collapsing their space while reordering", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);
		const trashActions = screen.getByTestId("content-trash-actions").element();
		const handle = screen.getByRole("button", { name: "Drag to reorder Publish" }).element();

		expect(trashActions).not.toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).not.toHaveAttribute("aria-hidden");

		handle.focus();
		await act(async () => {
			fireEvent.keyDown(handle, { key: " ", code: "Space" });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(trashActions).toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).toHaveAttribute("aria-hidden", "true");

		await act(async () => {
			fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(trashActions).not.toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).not.toHaveAttribute("aria-hidden");
	});
});

function makeBarProps(overrides: Partial<SettingsActionBarProps> = {}): SettingsActionBarProps {
	return {
		collectionLabel: "Post",
		isNew: false,
		isDirty: false,
		isSaving: false,
		isLive: false,
		hasPendingChanges: false,
		liveViewUrl: null,
		supportsPreview: false,
		isLoadingPreview: false,
		onPreview: vi.fn(),
		onPublish: vi.fn(),
		onUnpublish: vi.fn(),
		announceSaveStatus: true,
		...overrides,
	};
}

describe("SettingsActionBar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows Publish for an unpublished draft", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps()} />);
		const publish = screen.getByRole("button", { name: "Publish", exact: true });

		await expect.element(publish).toBeInTheDocument();
		expect(publish.element().className).toContain("button-emphasis-bg");
		expect(screen.container.textContent).not.toContain("Unpublish Post");
	});

	it("uses the normalized Publish label for every collection", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ collectionLabel: "API Docs" })} />,
		);

		await expect
			.element(screen.getByRole("button", { name: "Publish", exact: true }))
			.toBeInTheDocument();
	});

	it("shows Publish changes now for a live item with edits and no schedule option", async () => {
		const props = makeBarProps({ isLive: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const publishChanges = screen.getByRole("button", {
			name: "Publish changes now",
			exact: true,
		});
		await expect.element(publishChanges).toBeInTheDocument();
		expect(publishChanges.element().className).toContain("button-emphasis-bg");

		await publishChanges.click();
		expect(props.onPublish).toHaveBeenCalled();
	});

	it("shows Unpublish Post for a clean live item", async () => {
		const props = makeBarProps({ isLive: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const unpublish = screen.getByRole("button", { name: "Unpublish Post" });
		await expect.element(unpublish).toBeInTheDocument();

		await unpublish.click();
		expect(props.onUnpublish).toHaveBeenCalled();
	});

	it("renders Live View when a live URL is provided", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ liveViewUrl: "https://example.com/my-post" })} />,
		);
		const link = screen.getByRole("link", { name: /Live View/ });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute("href", "https://example.com/my-post");
	});

	it("renders Preview when preview is supported", async () => {
		const props = makeBarProps({ supportsPreview: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const preview = screen.getByRole("button", { name: "Preview draft" });
		await expect.element(preview).toBeInTheDocument();

		await preview.click();
		expect(props.onPreview).toHaveBeenCalled();
	});

	it("gives every action an intrinsic flexible layout slot", async () => {
		const screen = await render(
			<SettingsActionBar
				{...makeBarProps({
					isLive: true,
					hasPendingChanges: true,
					liveViewUrl: "https://example.com/my-post",
					supportsPreview: true,
				})}
			/>,
		);
		const actions = [
			screen.getByRole("button", { name: "Saved" }).element(),
			screen.getByRole("link", { name: "Live View" }).element(),
			screen.getByRole("button", { name: "Preview draft" }).element(),
			screen.getByRole("button", { name: "Publish changes now", exact: true }).element(),
		];
		const slots = actions.map((action) => action.parentElement);

		expect(new Set(slots)).toHaveLength(actions.length);
		for (const slot of slots) {
			expect(slot).toHaveClass("min-w-max", "flex-[1_1_auto]");
		}
		expect(slots[0]?.parentElement).toHaveClass("items-stretch");
	});

	it("hides the publish cluster for new items", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isNew: true })} />);

		expect(screen.container.textContent).not.toContain("Publish");
		expect(screen.container.textContent).not.toContain("Unpublish");
		// Save is still available
		await expect.element(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
	});

	it("shows autosave progress in the Save button", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ isDirty: true, isAutosaving: true })} />,
		);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		expect(screen.getByRole("status").element().textContent).toBe("Saving...");
	});

	it("can suppress its live region when another mounted copy announces status", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ announceSaveStatus: false })} />,
		);
		expect(screen.container.querySelector('span[role="status"][aria-live="polite"]')).toBeNull();
	});

	it("marks the Save button dirty state", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isDirty: true })} />);
		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }))
			.toBeInTheDocument();
	});
});
