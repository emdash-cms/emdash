import { packTar } from "modern-tar";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ApiResponseError } from "../../../src/lib/api/client.js";
import type {
	ScaffoldItem,
	SiteImportPlan,
	TransferApproval,
	TransferCapabilities,
	TransferOperation,
} from "../../../src/lib/api/transfer.js";
import { render } from "../../utils/render.js";

const api = vi.hoisted(() => ({
	fetchTransferCapabilities: vi.fn(),
	fetchTransferExports: vi.fn(),
	fetchTransferImports: vi.fn(),
	fetchTransferImport: vi.fn(),
	fetchTransferImportPlan: vi.fn(),
	fetchTransferApprovals: vi.fn(),
	analyzeTransferImport: vi.fn(),
	executeTransferImport: vi.fn(),
	advanceTransferImport: vi.fn(),
	advanceTransferExport: vi.fn(),
	createTransferImport: vi.fn(),
	createTransferExport: vi.fn(),
}));
const currentUserMock = vi.hoisted(() => vi.fn());
const fetchUsersMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/api/transfer.js", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/api/transfer.js")>(
		"../../../src/lib/api/transfer.js",
	);
	return { ...actual, ...api };
});
vi.mock("../../../src/lib/api/current-user.js", () => ({ useCurrentUser: currentUserMock }));
vi.mock("../../../src/lib/api/users.js", () => ({ fetchUsers: fetchUsersMock }));
vi.mock("../../../src/components/settings/BackToSettingsLink.js", () => ({
	BackToSettingsLink: () => <a href="/settings">Back to Settings</a>,
}));

const { TransferSettings } = await import("../../../src/components/settings/TransferSettings.js");

function capabilities(portableDomain: Partial<TransferCapabilities["portableDomain"]> = {}) {
	return {
		formatVersions: ["1"],
		features: [],
		optionalFeatures: [],
		limits: {
			manifestBytes: 8_388_608,
			recordLineBytes: 1_900_000,
			chunkBytes: 4_194_304,
			chunkRecords: 1000,
			totalRecords: 5_000_000,
			totalFiles: 1_000_000,
			indexChunks: 1000,
			jsonDepth: 64,
			maxBlobBytes: 52_428_800,
		},
		portableDomain: { empty: true, blockers: [], seededScaffold: [], ...portableDomain },
	} satisfies TransferCapabilities;
}

function importOperation(overrides: Partial<TransferOperation> = {}): TransferOperation {
	return {
		id: "imp1",
		kind: "import",
		state: "planned",
		stage: null,
		cursor: null,
		progress: null,
		options: null,
		idempotencyKey: null,
		packageDigest: `sha256:${"a".repeat(64)}`,
		planDigest: `sha256:${"b".repeat(64)}`,
		originSiteId: "origin",
		receipt: null,
		errorCode: null,
		errorDetail: null,
		writeEpoch: 0,
		attemptCount: 0,
		leaseExpiresAt: null,
		runtimeGeneration: 1,
		cancelRequestedAt: null,
		mutationStartedAt: null,
		createdBy: "admin",
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-01T10:00:00.000Z",
		completedAt: null,
		expiresAt: null,
		stagingCollectedAt: null,
		...overrides,
	};
}

function plan(overrides: Partial<SiteImportPlan> = {}): SiteImportPlan {
	return {
		formatVersion: "1",
		packageDigest: `sha256:${"a".repeat(64)}`,
		origin: {
			siteId: "origin",
			packageId: "pkg",
			createdAt: "2026-08-30T12:00:00.000Z",
			createdByEmDashVersion: "0.38.0",
		},
		target: { siteId: "target", dialect: "sqlite", emdashVersion: "0.38.0" },
		counts: { entry: 12, media: 3, principal: 2 },
		bytes: { records: 4096, media: 1_048_576 },
		principals: [
			{
				id: "p-ada",
				displayName: "Ada Lovelace",
				email: "ADA@example.com",
				references: 9,
				suggestedUserId: "u-ada",
			},
			{ id: "p-bob", displayName: "Bob Author", email: "bob@origin.test", references: 3 },
		],
		settings: { title: { package: "Origin Blog", target: "My Site" }, tagline: {} },
		decisions: {
			principalMappings: { "p-ada": "u-ada", "p-bob": null },
			siteTitle: "package",
			siteTagline: "package",
		},
		transformations: [
			{
				code: "seeded_scaffold_removed",
				count: 2,
				items: [
					{ type: "collection", id: "col-posts" },
					{ type: "menu", id: "menu-main" },
				],
			},
		],
		warnings: [],
		blockers: [],
		estimatedSteps: 10,
		...overrides,
	};
}

function setup(options: {
	capabilities?: TransferCapabilities;
	imports?: TransferOperation[];
	plan?: SiteImportPlan;
}) {
	api.fetchTransferCapabilities.mockResolvedValue(options.capabilities ?? capabilities());
	api.fetchTransferImports.mockResolvedValue({ items: options.imports ?? [] });
	api.fetchTransferImportPlan.mockResolvedValue({
		plan: options.plan ?? plan(),
		planDigest: `sha256:${"b".repeat(64)}`,
	});
}

describe("TransferSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUserMock.mockReturnValue({
			data: { id: "admin", email: "admin@example.com", role: 50 },
			isLoading: false,
		});
		fetchUsersMock.mockResolvedValue({
			items: [
				{ id: "u-ada", email: "ada@example.com", name: "Ada (target)" },
				{ id: "u-admin", email: "admin@example.com", name: "Admin" },
			],
		});
		api.fetchTransferExports.mockResolvedValue({ items: [] });
		api.fetchTransferApprovals.mockResolvedValue({ items: [] });
	});

	it("denies non-admins", async () => {
		currentUserMock.mockReturnValue({
			data: { id: "editor", email: "e@example.com", role: 40 },
			isLoading: false,
		});
		setup({});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Access denied")).toBeVisible();
		expect(api.fetchTransferCapabilities).not.toHaveBeenCalled();
	});

	it("offers a package file on an empty site", async () => {
		setup({});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByRole("button", { name: "Choose package file" })).toBeVisible();
	});

	it("moves focus to the import when opened to start one", async () => {
		setup({});
		const screen = await render(<TransferSettings focusImport />);
		const chooseButton = screen.getByRole("button", { name: "Choose package file" });
		await expect.element(chooseButton).toBeVisible();
		await vi.waitFor(() => {
			expect(document.activeElement?.contains(chooseButton.element())).toBe(true);
		});
	});

	it("leaves focus alone when opened normally", async () => {
		setup({});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByRole("button", { name: "Choose package file" })).toBeVisible();
		expect(document.activeElement).toBe(document.body);
	});

	it("explains why a site with content can’t receive an import", async () => {
		setup({
			capabilities: capabilities({
				empty: false,
				blockers: [
					{ code: "collection_has_entries", id: "c1", slug: "posts" },
					{ code: "table_not_empty", table: "media" },
				],
			}),
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("This site can’t receive an import")).toBeVisible();
		await expect.element(screen.getByText("Collection “posts” has entries")).toBeVisible();
		await expect.element(screen.getByText("Media: this site already has some")).toBeVisible();
		expect(screen.getByRole("button", { name: "Choose package file" }).elements()).toHaveLength(0);
	});

	it("asks for the package again when an upload was left unfinished", async () => {
		setup({ imports: [importOperation({ state: "uploading", planDigest: null })] });
		api.fetchTransferImport.mockResolvedValue({
			operation: importOperation({ state: "uploading", planDigest: null }),
			files: { declared: 4, verified: 2 },
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Upload not finished")).toBeVisible();
		await expect.element(screen.getByText(/4 files still need to be uploaded/)).toBeVisible();
	});

	it("explains that an earlier import of the chosen package left partial data", async () => {
		setup({});
		api.createTransferImport.mockResolvedValue({
			operation: importOperation({
				id: "dead1",
				state: "cancelled",
				mutationStartedAt: "2026-09-01T10:05:00.000Z",
			}),
			created: false,
			missing: { items: [] },
		});
		const manifest = new TextEncoder().encode(JSON.stringify({ index: [] }));
		const archive = await packTar([
			{
				header: { name: "manifest.json", size: manifest.byteLength, type: "file" },
				body: manifest,
			},
		]);
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByRole("button", { name: "Choose package file" })).toBeVisible();

		const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
		await userEvent.upload(
			input,
			new File([archive as Uint8Array<ArrayBuffer>], "site.emdash", { type: "application/x-tar" }),
		);

		await expect
			.element(screen.getByText("This site holds partial data from an earlier import"))
			.toBeVisible();
		await expect
			.element(screen.getByText(/Abandon that import, then reset this site/))
			.toBeVisible();
		expect(api.createTransferImport).toHaveBeenCalledTimes(1);
	});

	it("reopens a planned import at review with authors matched by email", async () => {
		setup({ imports: [importOperation()] });
		const screen = await render(<TransferSettings />);

		await expect.element(screen.getByText("Review the import")).toBeVisible();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		await expect.element(screen.getByText("Matched by email", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("1 of 2 matched by email")).toBeVisible();
		await expect
			.element(screen.getByRole("combobox", { name: "User for Ada Lovelace" }))
			.toHaveTextContent("Ada (target)");
		await expect
			.element(screen.getByRole("combobox", { name: "User for Bob Author" }))
			.toHaveTextContent("Don’t map");
		await expect.element(screen.getByRole("button", { name: "Start import" })).toBeEnabled();
	});

	it("lists the starter content the import removes and says so before confirming", async () => {
		setup({
			capabilities: capabilities({
				seededScaffold: [
					{ type: "collection", id: "col-posts", slug: "posts" },
					{ type: "menu", id: "menu-main", name: "primary", locale: "en" },
				],
			}),
			imports: [importOperation()],
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Starter content that will be removed")).toBeVisible();
		await expect.element(screen.getByText("posts", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("primary", { exact: true })).toBeVisible();

		await userEvent.click(screen.getByRole("button", { name: "Start import" }));
		const dialog = screen.getByRole("alertdialog", { name: "Import this package?" });
		await expect.element(dialog.getByText(/starter content listed above is deleted/)).toBeVisible();
	});

	it("names every kind of starter content, grouped by type", async () => {
		const terms = Array.from({ length: 15 }, (_, index) => ({
			type: "term" as const,
			id: `term-${index}`,
			name: `Topic ${index + 1}`,
			slug: `topic-${index + 1}`,
			locale: "en",
		}));
		const seededScaffold: ScaffoldItem[] = [
			{ type: "collection", id: "col-posts", slug: "posts" },
			{ type: "taxonomy_def", id: "tax-cat", name: "category", locale: "en" },
			...terms,
			{ type: "menu", id: "menu-main", name: "primary", locale: "en" },
			{ type: "menu_item", id: "item-home", menuId: "menu-main", label: "Home" },
			{ type: "widget_area", id: "area-side", name: "sidebar" },
			{ type: "widget", id: "widget-search", areaId: "area-side", widgetType: "search" },
			{ type: "section", id: "sec-hero", slug: "hero" },
		];
		setup({
			capabilities: capabilities({ seededScaffold }),
			imports: [importOperation()],
			plan: plan({
				transformations: [
					{
						code: "seeded_scaffold_removed",
						count: seededScaffold.length + 1,
						items: [
							...seededScaffold.map(({ type, id }) => ({ type, id })),
							{ type: "menu_item", id: "item-gone" },
						],
					},
				],
			}),
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Starter content that will be removed")).toBeVisible();
		for (const name of [
			"posts",
			"category",
			"primary",
			"Home in primary",
			"item-gone",
			"sidebar",
			"search in sidebar",
			"hero",
			"Topic 12",
		]) {
			await expect.element(screen.getByText(name, { exact: true })).toBeVisible();
		}
		const termGroup = screen.getByText("Terms", { exact: true }).element().closest("div")!;
		expect(termGroup.textContent).toContain("15");
		await expect.element(screen.getByText("Topic 13", { exact: true })).not.toBeVisible();
		await userEvent.click(screen.getByText("Show 3 more"));
		await expect.element(screen.getByText("Topic 15", { exact: true })).toBeVisible();
	});

	it("lists every difference from the source site once per code, with counts", async () => {
		setup({
			imports: [importOperation()],
			plan: plan({
				transformations: [
					{ code: "media_url_relativized", kind: "entry", count: 2 },
					{ code: "media_url_relativized", kind: "revision", count: 3 },
					{ code: "principal_mapped", count: 9 },
					{ code: "principal_unmapped", count: 3 },
					{ code: "redirect_loop_disabled", kind: "redirect", ids: ["r1", "r2"] },
					{ code: "locale_recased", locales: [{ from: "pt-br", to: "pt-BR" }] },
				],
			}),
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Differences from the source site")).toBeVisible();
		await expect.element(screen.getByText("Media links were made relative (5)")).toBeVisible();
		await expect.element(screen.getByText("Revisions", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("Some content will have no author (3)")).toBeVisible();
		await expect
			.element(screen.getByText("Redirects that loop will be imported turned off (2)"))
			.toBeVisible();
		await expect
			.element(screen.getByText("Locales will use this site’s capitalization"))
			.toBeVisible();
		await expect.element(screen.getByText("pt-br becomes pt-BR")).toBeVisible();
		expect(
			screen.getByText("Authors will be assigned to users on this site").elements(),
		).toHaveLength(0);
	});

	it("blocks confirming while the plan has blockers", async () => {
		setup({
			imports: [importOperation()],
			plan: plan({
				blockers: [
					{
						code: "locale_not_configured",
						message: "Locale fr is not configured",
						detail: { locale: "fr" },
					},
				],
			}),
		});
		const screen = await render(<TransferSettings />);
		await expect
			.element(screen.getByText("The package uses a locale this site does not have"))
			.toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Start import" })).toBeDisabled();
	});

	it("resubmits every decision when one changes and waits for the new plan", async () => {
		setup({ imports: [importOperation()] });
		let resolveAnalyze: (value: unknown) => void = () => {};
		api.analyzeTransferImport.mockReturnValue(
			new Promise((resolve) => {
				resolveAnalyze = resolve;
			}),
		);
		const screen = await render(<TransferSettings />);
		await userEvent.click(screen.getByText("Keep this site’s: “My Site”"));

		expect(api.analyzeTransferImport).toHaveBeenCalledWith("imp1", {
			principalMappings: { "p-ada": "u-ada", "p-bob": null },
			siteTitle: "target",
			siteTagline: "package",
		});
		await expect.element(screen.getByRole("button", { name: "Start import" })).toBeDisabled();

		const updated = plan({
			decisions: {
				principalMappings: { "p-ada": "u-ada", "p-bob": null },
				siteTitle: "target",
				siteTagline: "package",
			},
		});
		resolveAnalyze({
			operation: importOperation(),
			plan: updated,
			planDigest: `sha256:${"e".repeat(64)}`,
			nextRequestInMs: null,
		});
		await expect.element(screen.getByRole("button", { name: "Start import" })).toBeEnabled();
	});

	it("executes the reviewed plan by its digests", async () => {
		setup({ imports: [importOperation()] });
		api.executeTransferImport.mockResolvedValue(
			importOperation({ state: "planned", stage: "reserve" }),
		);
		api.advanceTransferImport.mockResolvedValue({
			operation: importOperation({
				state: "running",
				stage: "content",
				progress: { done: 5, total: 10 },
			}),
			nextRequestInMs: 60_000,
		});
		const screen = await render(<TransferSettings />);
		await userEvent.click(screen.getByRole("button", { name: "Start import" }));
		const dialog = screen.getByRole("alertdialog", { name: "Import this package?" });
		dialog.getByRole("button", { name: "Start import" }).element().focus();
		await userEvent.keyboard("{Enter}");

		await expect
			.poll(() => api.executeTransferImport.mock.calls[0])
			.toEqual([
				"imp1",
				{ packageDigest: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"b".repeat(64)}` },
			]);
		await expect.element(screen.getByText("Importing: Importing content")).toBeVisible();
	});

	it("reloads the plan when it changed elsewhere and waits for another review", async () => {
		setup({ imports: [importOperation()] });
		api.executeTransferImport.mockRejectedValue(
			new ApiResponseError(409, "TRANSFER_PLAN_DIGEST_MISMATCH", "Plan digest does not match"),
		);
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Review the import")).toBeVisible();
		api.fetchTransferImportPlan.mockResolvedValue({
			plan: plan({
				decisions: {
					principalMappings: { "p-ada": "u-ada", "p-bob": null },
					siteTitle: "target",
					siteTagline: "package",
				},
			}),
			planDigest: `sha256:${"e".repeat(64)}`,
		});

		await userEvent.click(screen.getByRole("button", { name: "Start import" }));
		const dialog = screen.getByRole("alertdialog", { name: "Import this package?" });
		dialog.getByRole("button", { name: "Start import" }).element().focus();
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByText("The import plan changed")).toBeVisible();
		await expect.element(dialog).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("radio", { name: "Keep this site’s: “My Site”" }))
			.toBeChecked();
		expect(api.executeTransferImport).toHaveBeenCalledTimes(1);

		api.executeTransferImport.mockResolvedValue(
			importOperation({ state: "planned", stage: "reserve" }),
		);
		api.advanceTransferImport.mockResolvedValue({
			operation: importOperation({ state: "running", stage: "content" }),
			nextRequestInMs: 60_000,
		});
		await userEvent.click(screen.getByRole("button", { name: "Start import" }));
		screen
			.getByRole("alertdialog", { name: "Import this package?" })
			.getByRole("button", { name: "Start import" })
			.element()
			.focus();
		await userEvent.keyboard("{Enter}");
		await expect
			.poll(() => api.executeTransferImport.mock.calls[1])
			.toEqual([
				"imp1",
				{ packageDigest: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"e".repeat(64)}` },
			]);
	});

	it("stops offering plan changes once the import was started elsewhere", async () => {
		setup({ imports: [importOperation()] });
		api.analyzeTransferImport.mockRejectedValue(
			new ApiResponseError(409, "TRANSFER_INVALID_STATE", "Import is executing"),
		);
		let resolveImports: (value: unknown) => void = () => {};
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Review the import")).toBeVisible();
		api.fetchTransferImports.mockReturnValue(
			new Promise((resolve) => {
				resolveImports = resolve;
			}),
		);

		await userEvent.click(screen.getByText("Keep this site’s: “My Site”"));

		await expect.element(screen.getByText("This import has already started")).toBeVisible();
		expect(screen.getByText("Couldn’t update the plan").elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole("radio", { name: "From the package: “Origin Blog”" }))
			.toBeChecked();
		await expect
			.element(screen.getByRole("radio", { name: "Keep this site’s: “My Site”" }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole("combobox", { name: "User for Ada Lovelace" }))
			.toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Start import" })).toBeDisabled();

		api.advanceTransferImport.mockResolvedValue({
			operation: importOperation({ state: "running", stage: "content" }),
			nextRequestInMs: 60_000,
		});
		resolveImports({ items: [importOperation({ state: "running", stage: "content" })] });
		await expect.element(screen.getByText("Importing: Importing content")).toBeVisible();
	});

	it("retries starting an export after a network failure without starting two", async () => {
		setup({});
		const failedExport: TransferOperation = {
			...importOperation({ id: "exp1", state: "failed", packageDigest: null, planDigest: null }),
			kind: "export",
		};
		api.createTransferExport
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValue(failedExport);
		const screen = await render(<TransferSettings />);

		await userEvent.click(screen.getByRole("button", { name: "Export site" }));
		await expect.element(screen.getByText("The last export failed")).toBeVisible();
		expect(api.createTransferExport).toHaveBeenCalledTimes(2);
		const [first, retried] = api.createTransferExport.mock.calls.map(([options]) => options);
		expect(first.idempotencyKey).toEqual(expect.any(String));
		expect(retried).toEqual(first);

		await userEvent.click(screen.getByRole("button", { name: "Export site" }));
		await expect.poll(() => api.createTransferExport.mock.calls.length).toBe(3);
		expect(api.createTransferExport.mock.calls[2]![0].idempotencyKey).not.toBe(
			first.idempotencyKey,
		);
	});

	it("shows a running export's reported progress", async () => {
		setup({});
		const running: TransferOperation = {
			...importOperation({
				id: "exp1",
				state: "running",
				stage: "export_media",
				packageDigest: null,
				planDigest: null,
				cursor: { kind: "entry", summary: { chunks: { entry: [7] } } },
				progress: { done: 3, total: 10, bytesDone: 1024, bytesTotal: 4096 },
			}),
			kind: "export",
		};
		api.fetchTransferExports.mockResolvedValue({ items: [running] });
		api.advanceTransferExport.mockResolvedValue({ operation: running, nextRequestInMs: 60_000 });
		const screen = await render(<TransferSettings />);

		await expect.element(screen.getByText("Exporting: Checking media files")).toBeVisible();
		await expect.element(screen.getByText("3 of 10 steps · 1 KB of 4 KB")).toBeVisible();
		expect(screen.getByText(/records written/).elements()).toHaveLength(0);
	});

	it("shows how many records a running export has written", async () => {
		setup({});
		const running: TransferOperation = {
			...importOperation({
				id: "exp1",
				state: "running",
				stage: "export_records",
				packageDigest: null,
				planDigest: null,
				progress: { done: 2, total: 9, records: 9 },
			}),
			kind: "export",
		};
		api.fetchTransferExports.mockResolvedValue({ items: [running] });
		api.advanceTransferExport.mockResolvedValue({ operation: running, nextRequestInMs: 60_000 });
		const screen = await render(<TransferSettings />);

		await expect.element(screen.getByText("9 records written")).toBeVisible();
	});

	it("loads further pages of pending approval requests", async () => {
		setup({});
		const approval = (id: string, userId: string, action: "export" | "import") =>
			({
				id,
				status: "pending",
				action,
				userId,
				requestedByTokenId: null,
				approvedBy: null,
				operationId: null,
				paramsDigest: null,
				packageDigest: null,
				planDigest: null,
				expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
				createdAt: new Date().toISOString(),
				decidedAt: null,
				consumedAt: null,
			}) satisfies TransferApproval;
		api.fetchTransferApprovals.mockImplementation(async ({ cursor }: { cursor?: string }) =>
			cursor === "page2"
				? { items: [approval("ap2", "u-admin", "import")] }
				: { items: [approval("ap1", "u-ada", "export")], nextCursor: "page2" },
		);
		const screen = await render(<TransferSettings />);

		await expect.element(screen.getByText("Export requested by Ada (target)")).toBeVisible();
		expect(screen.getByText("Import requested by Admin").elements()).toHaveLength(0);

		await userEvent.click(screen.getByRole("button", { name: "Load more" }));
		await expect.element(screen.getByText("Import requested by Admin")).toBeVisible();
		await expect.element(screen.getByText("Export requested by Ada (target)")).toBeVisible();
		expect(api.fetchTransferApprovals).toHaveBeenLastCalledWith({
			status: "pending",
			cursor: "page2",
		});
		expect(screen.getByRole("button", { name: "Load more" }).elements()).toHaveLength(0);
	});

	it("shows a verified receipt for a completed import", async () => {
		const receipt = {
			operationId: "imp1",
			packageDigest: `sha256:${"a".repeat(64)}`,
			planDigest: `sha256:${"b".repeat(64)}`,
			targetSiteId: "target",
			originSiteId: "origin",
			formatVersion: "1",
			importerEmDashVersion: "0.38.0",
			completedAt: "2026-09-01T11:00:00.000Z",
			logicalDigest: `sha256:${"c".repeat(64)}`,
			counts: { entry: 12 },
			warnings: [],
			verification: "verified",
			receiptDigest: `sha256:${"d".repeat(64)}`,
		} as const;
		setup({
			capabilities: capabilities({
				empty: false,
				blockers: [{ code: "table_not_empty", table: "media" }],
			}),
			imports: [importOperation({ state: "complete", receipt })],
		});
		const screen = await render(<TransferSettings />);
		await expect.element(screen.getByText("Import complete")).toBeVisible();
		await expect.element(screen.getByText("Verified")).toBeVisible();
		await expect.element(screen.getByText(receipt.receiptDigest)).toBeVisible();
	});
});
