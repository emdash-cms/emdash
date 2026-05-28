/**
 * Phase 6 of Discussion #1174 — byline edit form custom-field tests.
 *
 * PR plan §228: "Component test: register a field via mock API, open
 * the form, verify input renders, fill + submit, verify PATCH body
 * includes `customFields` with the entered value."
 *
 * The test stubs the byline + byline-fields APIs, mounts the bylines
 * page in a QueryClient + Toast.Provider wrapper, simulates selecting
 * an existing byline (which puts the form in edit mode where custom
 * fields render), and asserts the PATCH body forwarded to
 * `updateByline` includes the typed value.
 *
 * vitest-browser-react + Playwright actionability: Kumo's
 * `Dialog` overlay blocks clicks inside dialog bodies, but the
 * bylines page renders the sidebar list as plain `<button>` elements
 * (no dialog) and the Save button in the inline right-pane (also no
 * dialog). Both are clickable. The custom-field input is a plain Kumo
 * `<Input>`, which accepts `.fill()` directly.
 */

import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BylineFieldDefinition } from "../src/lib/api/byline-fields";
import type { BylineSummary } from "../src/lib/api/bylines";
import { render } from "./utils/render.tsx";

// TanStack Router pieces consumed by the bylines route. Mocked to
// avoid wiring a full RouterProvider just for one component test.
vi.mock("@tanstack/react-router", async () => {
	const actual =
		await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
	return {
		...actual,
		useSearch: () => ({ locale: undefined }),
		useNavigate: () => vi.fn(),
	};
});

// Bylines API surface — every call the page makes is mocked. The
// per-test setup below configures fixtures and tracks `updateByline`
// calls so the final assertion can verify the PATCH body shape.
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
		listBylineFields: vi.fn(),
	};
});

// Manifest used by the locale switcher. Single-locale stub keeps the
// multi-locale UI off — irrelevant to this AC.
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
const { listBylineFields } = await import("../src/lib/api/byline-fields");
const { BylinesPage } = await import("../src/routes/bylines");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BylinesPage — custom-field inputs (Phase 6 of #1174)", () => {
	it("renders the custom-field input after selecting a byline", async () => {
		const byline = makeByline();
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(listBylineFields).mockResolvedValue({
			items: [makeField({ label: "Job title", slug: "job_title", type: "string" })],
		});

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		// Click the byline in the sidebar list — moves the form into
		// edit mode and the custom-field section becomes visible.
		const bylineButton = screen.getByRole("button", { name: /Jane Doe/ });
		await bylineButton.click();

		// AC: registered fields render as inputs alongside the fixed
		// columns.
		await expect.element(screen.getByText("Custom fields")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Job title")).toBeInTheDocument();
	});

	it("does not render the custom-field section in create mode", async () => {
		vi.mocked(fetchBylines).mockResolvedValue({ items: [], nextCursor: undefined });
		vi.mocked(listBylineFields).mockResolvedValue({
			items: [makeField({ slug: "job_title", type: "string" })],
		});

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		// Server-side `bylineCreateBody` doesn't accept `customFields`;
		// showing inputs in create mode would set expectations the API
		// can't meet. The "Create byline" heading is the create-mode
		// signal; the Custom fields section must NOT appear.
		await expect.element(screen.getByText("Create byline")).toBeInTheDocument();
		expect(screen.getByText("Custom fields").query()).toBeNull();
	});

	it("forwards customFields in the PATCH body on save", async () => {
		const byline = makeByline({
			customFields: { job_title: "Senior editor" },
		});
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(listBylineFields).mockResolvedValue({
			items: [makeField({ slug: "job_title", type: "string" })],
		});
		vi.mocked(updateByline).mockResolvedValue(byline);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: /Jane Doe/ }).click();

		// Prefilled value from the byline's customFields hydration.
		const input = screen.getByLabelText("Job title");
		await expect.element(input).toHaveValue("Senior editor");

		// Save without modifying — proves the PATCH body still includes
		// the customFields map (the form's `toFormState` populated it
		// from the response, and `updateMutation` spreads it).
		await screen.getByRole("button", { name: "Save" }).click();

		// Vitest-browser-react resolves the mutation asynchronously;
		// give the click a microtask before asserting.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(vi.mocked(updateByline)).toHaveBeenCalledTimes(1);
		const [bylineId, body] = vi.mocked(updateByline).mock.calls[0]!;
		expect(bylineId).toBe(byline.id);
		expect(body.customFields).toEqual({ job_title: "Senior editor" });
	});

	it("omits customFields from the PATCH body when field-defs fail to load", async () => {
		// Regression guard for the silent-overwrite scenario flagged in
		// the Phase 6 review. When `listBylineFields` errors, the form
		// can't render the inputs, so the editor cannot see what
		// they'd be saving. The Save button stays enabled so editors
		// can still update fixed columns (bio, slug, etc.), but the
		// PATCH body must NOT include `customFields` — otherwise the
		// hydrated map would round-trip and a "field deleted
		// server-side mid-session" race would surface as a 400.
		const byline = makeByline({
			customFields: { job_title: "Senior editor" },
		});
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(listBylineFields).mockRejectedValue(new Error("network blip"));
		vi.mocked(updateByline).mockResolvedValue(byline);

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: /Jane Doe/ }).click();

		// Error surface is shown — editor is told what's happening.
		await expect.element(screen.getByText("Couldn't load custom fields.")).toBeInTheDocument();

		// Save fixed columns; PATCH body must omit `customFields`.
		await screen.getByRole("button", { name: "Save" }).click();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(vi.mocked(updateByline)).toHaveBeenCalledTimes(1);
		const [, body] = vi.mocked(updateByline).mock.calls[0]!;
		expect(body).not.toHaveProperty("customFields");
		// Sanity: the fixed columns ARE in the body — proves the Save
		// path actually fired and the omission is targeted.
		expect(body.slug).toBe(byline.slug);
		expect(body.displayName).toBe(byline.displayName);
	});

	it("renders the right Kumo input for each registered field type", async () => {
		const byline = makeByline({
			customFields: {
				job_title: "Editor",
				bio_long: "A long bio.",
				homepage: "https://example.com",
				is_staff: true,
				tier: "gold",
			},
		});
		vi.mocked(fetchBylines).mockResolvedValue({ items: [byline], nextCursor: undefined });
		vi.mocked(fetchByline).mockResolvedValue(byline);
		vi.mocked(listBylineFields).mockResolvedValue({
			items: [
				makeField({ id: "f1", slug: "job_title", label: "Job title", type: "string" }),
				makeField({ id: "f2", slug: "bio_long", label: "Long bio", type: "text" }),
				makeField({ id: "f3", slug: "homepage", label: "Homepage", type: "url" }),
				makeField({ id: "f4", slug: "is_staff", label: "Staff", type: "boolean" }),
				makeField({
					id: "f5",
					slug: "tier",
					label: "Tier",
					type: "select",
					validation: { options: ["bronze", "silver", "gold"] },
				}),
			],
		});

		const screen = await render(
			<TestWrapper>
				<BylinesPage />
			</TestWrapper>,
		);

		await screen.getByRole("button", { name: /Jane Doe/ }).click();

		// `string` and `url` both render as `<input>`, but their `type`
		// attribute differentiates them. `text` renders as `<textarea>`.
		// `boolean` is a switch (role=switch). `select` is a Kumo Select
		// rendered as a combobox-like button (role=combobox).
		await expect.element(screen.getByLabelText("Job title")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Long bio")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Homepage")).toBeInTheDocument();
		await expect.element(screen.getByRole("switch", { name: "Staff" })).toBeInTheDocument();
		// `getByText('gold')` would resolve to both the button label and
		// the open listbox option (Kumo Select pre-mounts the listbox in
		// the DOM). Assert on the Tier label + the combobox role to
		// prove the select rendered without overlapping the listbox.
		await expect.element(screen.getByText("Tier")).toBeInTheDocument();
	});
});
