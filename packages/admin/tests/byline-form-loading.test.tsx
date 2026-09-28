import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import "../dist/styles.css";
import type { BylineFieldDefinition } from "../src/lib/api/byline-fields";
import type { BylineSummary } from "../src/lib/api/bylines";
import { render } from "./utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual =
		await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
	return {
		...actual,
		useSearch: () => ({ locale: undefined }),
		useNavigate: () => vi.fn(),
	};
});

vi.mock("../src/lib/api/bylines", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/bylines")>("../src/lib/api/bylines");
	return {
		...actual,
		fetchBylines: vi.fn(),
		fetchByline: vi.fn(),
		fetchBylineTranslations: vi.fn(),
		createByline: vi.fn(),
		updateByline: vi.fn(),
		deleteByline: vi.fn(),
		createBylineTranslation: vi.fn(),
	};
});

vi.mock("../src/lib/api/users", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/users")>("../src/lib/api/users");
	return {
		...actual,
		fetchUsers: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
	};
});

vi.mock("../src/lib/api/byline-fields", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/api/byline-fields")>(
		"../src/lib/api/byline-fields",
	);
	return {
		...actual,
		listBylineFields: vi.fn(),
	};
});

vi.mock("../src/lib/api/client", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/client")>("../src/lib/api/client");
	return {
		...actual,
		fetchManifest: vi.fn(),
	};
});

const { fetchBylines, fetchByline, fetchBylineTranslations, updateByline } =
	await import("../src/lib/api/bylines");
const { listBylineFields } = await import("../src/lib/api/byline-fields");
const { fetchManifest } = await import("../src/lib/api/client");
const { BylinesPage } = await import("../src/routes/bylines");

function makeByline(overrides: Partial<BylineSummary> = {}): BylineSummary {
	return {
		id: "byline_01",
		slug: "jane-doe",
		displayName: "Jane Doe",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: true,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		locale: "en",
		translationGroup: "group_01",
		customFields: {},
		...overrides,
	};
}

function makeField(overrides: Partial<BylineFieldDefinition> = {}): BylineFieldDefinition {
	return {
		id: "fld_01",
		slug: "job_title",
		label: "Job title",
		type: "string",
		required: false,
		translatable: true,
		validation: null,
		sortOrder: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function manifest(locales: string[]) {
	return {
		version: "0.0.0",
		hash: "test",
		collections: {},
		plugins: {},
		authMode: "passkey",
		taxonomies: [],
		...(locales.length > 1 ? { i18n: { defaultLocale: locales[0]!, locales } } : {}),
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function TestWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>
			<Toast.Provider>{children}</Toast.Provider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listBylineFields).mockResolvedValue({
		items: [makeField({ label: "Job title", slug: "job_title", type: "string" })],
	});
	vi.mocked(fetchBylineTranslations).mockResolvedValue({ items: [] });
});

describe("BylinesPage — editing while the byline loads", () => {
	it("keeps edits typed before the full byline record finishes loading", async () => {
		const byline = makeByline();
		vi.mocked(fetchManifest).mockResolvedValue(manifest(["en"]));
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		const remote = deferred<BylineSummary>();
		vi.mocked(fetchByline).mockReturnValue(remote.promise);
		vi.mocked(updateByline).mockResolvedValue(byline);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: "Edit Jane Doe" }).click();
		await userEvent.fill(screen.getByLabelText("Display name"), "Jane Q. Doe");
		await userEvent.fill(screen.getByLabelText("Job title"), "Editor");

		remote.resolve({ ...byline, displayName: "Jane Doe (remote)" });
		await expect
			.element(screen.getByText("Update the profile for Jane Doe (remote)."))
			.toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 50));

		await expect.element(screen.getByLabelText("Display name")).toHaveValue("Jane Q. Doe");
		await expect.element(screen.getByLabelText("Job title")).toHaveValue("Editor");

		await screen.getByRole("button", { name: "Save" }).click();

		await vi.waitFor(() => expect(vi.mocked(updateByline)).toHaveBeenCalledTimes(1));
		const [, body] = vi.mocked(updateByline).mock.calls[0]!;
		expect(body.displayName).toBe("Jane Q. Doe");
		expect(body.customFields).toEqual({ job_title: "Editor" });
	});

	it("fills an unedited form from the full byline record when it arrives", async () => {
		const byline = makeByline();
		vi.mocked(fetchManifest).mockResolvedValue(manifest(["en"]));
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		const remote = deferred<BylineSummary>();
		vi.mocked(fetchByline).mockReturnValue(remote.promise);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: "Edit Jane Doe" }).click();
		remote.resolve({ ...byline, customFields: { job_title: "Columnist" } });

		await expect.element(screen.getByLabelText("Job title")).toHaveValue("Columnist");
	});

	it("opens a byline with its saved values straight after saving it", async () => {
		const byline = makeByline();
		const saved = makeByline({ displayName: "Jane Q. Doe", customFields: { job_title: "Editor" } });
		let hasSaved = false;
		vi.mocked(fetchManifest).mockResolvedValue(manifest(["en"]));
		vi.mocked(fetchBylines).mockImplementation(() =>
			hasSaved
				? new Promise(() => {})
				: Promise.resolve({ items: [byline], nextCursor: undefined }),
		);
		vi.mocked(fetchByline).mockImplementation(() =>
			hasSaved ? new Promise(() => {}) : Promise.resolve(byline),
		);
		vi.mocked(updateByline).mockImplementation(async () => {
			hasSaved = true;
			return saved;
		});

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: "Edit Jane Doe" }).click();
		await expect.element(screen.getByText("Update the profile for Jane Doe.")).toBeInTheDocument();
		await userEvent.fill(screen.getByLabelText("Display name"), "Jane Q. Doe");
		await userEvent.fill(screen.getByLabelText("Job title"), "Editor");
		await screen.getByRole("button", { name: "Save" }).click();
		await expect
			.element(screen.getByRole("dialog", { name: "Edit byline" }))
			.not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit Jane Q. Doe" }).click();

		await expect.element(screen.getByLabelText("Display name")).toHaveValue("Jane Q. Doe");
		await expect.element(screen.getByLabelText("Job title")).toHaveValue("Editor");
	});

	it("loads a translation opened from the translations panel before it can be saved", async () => {
		const english = makeByline();
		const french = makeByline({
			id: "byline_02",
			slug: "jeanne-doe",
			displayName: "Jeanne Doe",
			locale: "fr",
			customFields: { job_title: "Rédactrice" },
		});
		vi.mocked(fetchManifest).mockResolvedValue(manifest(["en", "fr"]));
		vi.mocked(fetchBylines).mockResolvedValue({ items: [english], nextCursor: undefined });
		vi.mocked(fetchBylineTranslations).mockResolvedValue({ items: [english, french] });
		const frenchRemote = deferred<BylineSummary>();
		vi.mocked(fetchByline).mockImplementation((id) =>
			id === french.id ? frenchRemote.promise : Promise.resolve(english),
		);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: "Edit Jane Doe" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline" });
		await dialog.getByRole("button", { name: "Edit", exact: true }).click();

		await expect.element(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

		frenchRemote.resolve(french);

		await expect.element(screen.getByLabelText("Display name")).toHaveValue("Jeanne Doe");
		await expect.element(screen.getByLabelText("Job title")).toHaveValue("Rédactrice");
		await expect.element(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
	});
});
