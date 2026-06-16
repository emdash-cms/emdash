/**
 * Byline avatar field tests (#1250).
 *
 * The `avatarMediaId` field is part of the byline data model and is
 * accepted by the create/update API, but the admin editor never
 * rendered a control for it — so editors had no way to set a byline
 * avatar, and (worse) every UI edit coerced the field back to `null`,
 * wiping any value set programmatically.
 *
 * These tests assert the avatar picker renders in the editor and that
 * a hydrated `avatarMediaId` round-trips through the PATCH body on
 * save. Driving the MediaPickerModal dialog itself is out of scope
 * here (its overlay blocks Playwright clicks — see the custom-fields
 * test for the same constraint); the round-trip proves the form state
 * is wired into the update body, which is the regression that matters.
 */

import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BylineSummary } from "../src/lib/api/bylines";
import type { MediaItem } from "../src/lib/api/media";
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
		fetchBylineTranslations: vi.fn().mockResolvedValue({ items: [] }),
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
		// No custom fields — keeps the editor to its fixed columns.
		listBylineFields: vi.fn().mockResolvedValue({ items: [] }),
	};
});

vi.mock("../src/lib/api/media", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/media")>("../src/lib/api/media");
	return {
		...actual,
		fetchMediaItem: vi.fn(),
	};
});

vi.mock("../src/lib/api/client", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/client")>("../src/lib/api/client");
	return {
		...actual,
		fetchManifest: vi.fn().mockResolvedValue({
			version: "0.0.0",
			hash: "test",
			collections: {},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
		}),
	};
});

const { fetchBylines, fetchByline, updateByline } = await import("../src/lib/api/bylines");
const { fetchMediaItem } = await import("../src/lib/api/media");
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
		translationGroup: null,
		customFields: {},
		...overrides,
	};
}

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media_avatar_01",
		filename: "avatar.jpg",
		mimeType: "image/jpeg",
		url: "/_emdash/api/media/file/media_avatar_01.jpg",
		storageKey: "media_avatar_01.jpg",
		size: 1024,
		createdAt: new Date().toISOString(),
		...overrides,
	};
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
});

describe("BylinesPage — avatar field (#1250)", () => {
	it("renders the avatar picker in create mode", async () => {
		vi.mocked(fetchBylines).mockResolvedValue({ items: [], nextCursor: undefined });

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await expect.element(screen.getByText("Create byline")).toBeInTheDocument();
		// The avatar field renders its label and an empty-state select button.
		await expect.element(screen.getByText("Avatar")).toBeInTheDocument();
		// No avatar set → no resolve query fires.
		expect(vi.mocked(fetchMediaItem)).not.toHaveBeenCalled();
	});

	it("resolves the stored avatar media for preview when editing", async () => {
		const byline = makeByline({ avatarMediaId: "media_avatar_01" });
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(fetchMediaItem).mockResolvedValue(makeMediaItem());

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: /Jane Doe/ }).click();

		await expect.element(screen.getByText("Avatar")).toBeInTheDocument();
		// The field resolves the stored id into a media item for display.
		await vi.waitFor(() =>
			expect(vi.mocked(fetchMediaItem)).toHaveBeenCalledWith("media_avatar_01"),
		);
	});

	it("forwards avatarMediaId in the PATCH body on save", async () => {
		const byline = makeByline({ avatarMediaId: "media_avatar_01" });
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(fetchMediaItem).mockResolvedValue(makeMediaItem());
		vi.mocked(updateByline).mockResolvedValue(byline);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: /Jane Doe/ }).click();
		await screen.getByRole("button", { name: "Save" }).click();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(vi.mocked(updateByline)).toHaveBeenCalledTimes(1);
		const [bylineId, body] = vi.mocked(updateByline).mock.calls[0]!;
		expect(bylineId).toBe(byline.id);
		expect(body.avatarMediaId).toBe("media_avatar_01");
	});
});
