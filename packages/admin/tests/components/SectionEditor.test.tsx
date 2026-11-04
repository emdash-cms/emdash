import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest, Section } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// Capture props passed to PortableTextEditor so the test can invoke the
// block-sidebar callbacks the way the image node view does at runtime.
const portableTextProps: { current: Record<string, unknown> | null } = { current: null };

vi.mock("../../src/components/PortableTextEditor", () => ({
	PortableTextEditor: (props: Record<string, unknown>) => {
		portableTextProps.current = props;
		return <div data-testid="portable-text-editor" />;
	},
}));

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...(actual as Record<string, unknown>),
		Link: ({ children, to, ...props }: { children: React.ReactNode; to?: string }) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
		useParams: () => ({ slug: "footer" }),
		useNavigate: () => vi.fn(),
	};
});

const mockFetchSection = vi.fn<() => Promise<Section>>();
const mockUpdateSection = vi.fn();
const mockFetchManifest = vi.fn<() => Promise<AdminManifest>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...(actual as Record<string, unknown>),
		fetchSection: (...args: unknown[]) => mockFetchSection(...(args as [])),
		updateSection: (...args: unknown[]) => mockUpdateSection(...(args as [])),
		fetchManifest: (...args: unknown[]) => mockFetchManifest(...(args as [])),
	};
});

// Import after mocks so the module under test picks up the mocked deps.
const { SectionEditor } = await import("../../src/components/SectionEditor");

function makeSection(overrides: Partial<Section> = {}): Section {
	return {
		id: "sec_footer",
		slug: "footer",
		title: "Footer",
		description: "All page footer",
		keywords: [],
		content: [],
		source: "user",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		...overrides,
	};
}

function makeManifest(overrides: Partial<AdminManifest> = {}): AdminManifest {
	return {
		version: "0.1.0",
		hash: "abc123",
		authMode: "passkey",
		collections: {},
		plugins: {},
		...overrides,
	};
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

describe("SectionEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		portableTextProps.current = null;
		mockFetchSection.mockResolvedValue(makeSection());
		mockFetchManifest.mockResolvedValue(makeManifest());
	});
	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it.each(["ltr", "rtl"])(
		"keeps detail inputs within their panel at a narrow width in %s",
		async (direction) => {
			await page.viewport(938, 880);
			const screen = await render(
				<div dir={direction} style={{ display: "flex", width: "100vw" }}>
					<aside style={{ width: 260, flexShrink: 0 }} />
					<main style={{ flex: 1, minWidth: 0, padding: 24 }}>
						<SectionEditor />
					</main>
				</div>,
				{ wrapper: Wrapper },
			);
			await expect.element(screen.getByRole("textbox", { name: "Keywords" })).toBeInTheDocument();

			const panel = screen
				.getByRole("heading", { name: "Section Details" })
				.element().parentElement!;
			const panelBounds = panel.getBoundingClientRect();
			const styles = getComputedStyle(panel);
			const contentStart = panelBounds.left + parseFloat(styles.paddingLeft);
			const contentEnd = panelBounds.right - parseFloat(styles.paddingRight);
			for (const name of ["Title", "Slug", "Description", "Keywords"]) {
				const fieldBounds = screen.getByRole("textbox", { name }).element().getBoundingClientRect();
				expect(fieldBounds.left).toBeGreaterThanOrEqual(contentStart - 1);
				expect(fieldBounds.right).toBeLessThanOrEqual(contentEnd + 1);
			}
		},
	);

	it("opens the image settings panel when a block requests the sidebar", async () => {
		const screen = await render(<SectionEditor />, { wrapper: Wrapper });

		// Editor must mount (and capture its props) before we can simulate.
		await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();

		const onBlockSidebarOpen = portableTextProps.current?.onBlockSidebarOpen as
			| ((panel: unknown) => void)
			| undefined;
		const onBlockSidebarClose = portableTextProps.current?.onBlockSidebarClose as
			| (() => void)
			| undefined;

		// Both callbacks must be wired — without them, clicking the image-settings
		// icon in the editor is a silent no-op (#845).
		expect(typeof onBlockSidebarOpen).toBe("function");
		expect(typeof onBlockSidebarClose).toBe("function");

		// Simulate the image node view asking for sidebar space, the same shape
		// it sends from ImageNode.openSidebar(). expect.element below polls until
		// React flushes the state update, so we don't need an explicit act wrapper.
		onBlockSidebarOpen!({
			type: "image",
			attrs: {
				src: "https://example.com/logo.png",
				alt: "Logo",
				mediaId: "media-1",
				width: 400,
				height: 200,
			},
			onUpdate: vi.fn(),
			onReplace: vi.fn(),
			onDelete: vi.fn(),
			onClose: vi.fn(),
		});

		// The Image Settings panel should now be rendered in the sidebar slot.
		// The panel renders the image preview using the src we passed.
		await expect.element(screen.getByRole("img", { name: "Logo" })).toBeInTheDocument();
	});

	it("shows both clean save actions as Saved", async () => {
		const screen = await render(<SectionEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();
		const saveButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(saveButtons).toHaveLength(2);
		for (const button of saveButtons) await expect.element(button).toBeDisabled();
		expect(screen.getByRole("status").element().textContent).toBe("Saved");
	});

	it("passes plugin block definitions to PortableTextEditor", async () => {
		const manifest = makeManifest({
			plugins: {
				"plugin-embeds": {
					portableTextBlocks: [
						{
							type: "youtube",
							label: "YouTube",
							icon: "YoutubeLogo",
						},
					],
				},
			},
		});
		mockFetchManifest.mockResolvedValue(manifest);

		const screen = await render(<SectionEditor />, { wrapper: Wrapper });
		await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();

		expect(portableTextProps.current?.pluginBlocks).toEqual([
			{
				type: "youtube",
				pluginId: "plugin-embeds",
				label: "YouTube",
				icon: "YoutubeLogo",
			},
		]);
	});
});
