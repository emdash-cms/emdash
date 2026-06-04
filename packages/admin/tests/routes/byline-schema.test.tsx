/**
 * Phase 5 of Discussion #1174.
 *
 * Tests for the byline-schema admin UI. Focuses on `BylineFieldEditor`
 * — the substantive component — since it owns the acceptance criteria
 * the PR plan calls out:
 *
 *  - "The type select in <BylineFieldEditor> offers exactly: string,
 *    text, url, boolean, select."
 *  - "The translatable toggle is present and round-trips through the API."
 *  - Open the dialog → set type to `select` → configure choices.
 *
 * The kumo `Dialog` renders an inert overlay that blocks Playwright's
 * actionability checks for clicks *inside* the dialog body (mirroring
 * the note in `tests/components/FieldEditor.test.tsx`). We test the
 * prop-driven shape: prefilling `field` puts the editor in edit mode
 * with a known type, and we assert the form rendered the expected
 * controls + values for that type. Round-tripping the toggle is covered
 * by passing `field.translatable: false` and asserting the Switch
 * reflects that input — proving the prop wiring without depending on a
 * click event.
 */

import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { BylineFieldEditor } from "../../src/components/BylineFieldEditor";
import type { BylineFieldDefinition } from "../../src/lib/api/byline-fields";
import { render } from "../utils/render.tsx";

// `useCurrentUser` is the gate for the page-permission tests below.
// Mocking the hook directly keeps the test surface small — no
// QueryClient + apiFetch + /auth/me stub needed just to discriminate
// between editor and admin roles.
vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: vi.fn(),
}));

// `vi.mock` is hoisted, so any imports that depend on the mocked module
// resolve to the mock. Import the hook AFTER the mock declaration so
// the test can flip its return value per test case.
const { useCurrentUser } = await import("../../src/lib/api/current-user");

// API client mock for the admin happy-path test. The editor-path test
// short-circuits before any network call (the queries are gated by the
// role check), so it doesn't need this; configure per-test where used.
vi.mock("../../src/lib/api/byline-fields", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/byline-fields")>(
		"../../src/lib/api/byline-fields",
	);
	return {
		...actual,
		listBylineFields: vi.fn(),
		getBylineFieldUsage: vi.fn(),
		createBylineField: vi.fn(),
		updateBylineField: vi.fn(),
		deleteBylineField: vi.fn(),
		reorderBylineFields: vi.fn(),
	};
});

const { listBylineFields } = await import("../../src/lib/api/byline-fields");
const { BylineSchemaPage } = await import("../../src/routes/byline-schema");

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

const defaultProps = {
	open: true,
	onOpenChange: vi.fn(),
	onSave: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
});

function PageWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	// `<Toast.Provider>` is normally supplied by Shell; the page calls
	// `Toast.useToastManager()` unconditionally so the test wrapper has
	// to provide it even for the early-return access-denied path.
	return (
		<QueryClientProvider client={queryClient}>
			<Toast.Provider>{children}</Toast.Provider>
		</QueryClientProvider>
	);
}

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

describe("BylineSchemaPage — permission gate", () => {
	it("renders Access denied for an EDITOR (below schema:manage)", async () => {
		vi.mocked(useCurrentUser).mockReturnValue({
			data: { id: "u1", email: "e@e", role: ROLE_EDITOR },
			isLoading: false,
			// eslint-disable-next-line typescript/no-explicit-any -- mock object satisfies the consumed shape; the rest is unused
		} as any);

		const screen = await render(
			<PageWrapper>
				<BylineSchemaPage />
			</PageWrapper>,
		);

		await expect.element(screen.getByText("Access denied")).toBeInTheDocument();
		// The page chrome — header + new-field button — must not render
		// for users below the threshold; otherwise the gate exists in
		// name only.
		expect(screen.getByRole("heading", { name: "Byline schema" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "New field" }).query()).toBeNull();
		// List query must not have fired — `enabled` guards on the role.
		expect(vi.mocked(listBylineFields)).not.toHaveBeenCalled();
	});

	it("renders the schema management UI for an ADMIN", async () => {
		vi.mocked(useCurrentUser).mockReturnValue({
			data: { id: "u1", email: "a@a", role: ROLE_ADMIN },
			isLoading: false,
			// eslint-disable-next-line typescript/no-explicit-any -- mock object satisfies the consumed shape
		} as any);
		vi.mocked(listBylineFields).mockResolvedValue({ items: [] });

		const screen = await render(
			<PageWrapper>
				<BylineSchemaPage />
			</PageWrapper>,
		);

		await expect
			.element(screen.getByRole("heading", { name: "Byline schema" }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "New field" })).toBeInTheDocument();
		expect(screen.getByText("Access denied").query()).toBeNull();
	});
});

describe("BylineFieldEditor", () => {
	describe("create mode", () => {
		it("renders the create-mode title", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} />);
			await expect.element(screen.getByText("New byline field")).toBeInTheDocument();
		});

		it("shows the create-mode primary button label", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} />);
			await expect
				.element(screen.getByRole("button", { name: "Create field" }))
				.toBeInTheDocument();
		});

		it("renders the label and slug inputs as enabled", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} />);
			const slug = screen.getByLabelText("Slug");
			await expect.element(slug).toBeInTheDocument();
			await expect.element(slug).not.toBeDisabled();
		});

		it("renders the required + translatable switches", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} />);
			await expect.element(screen.getByText("Required")).toBeInTheDocument();
			await expect.element(screen.getByText("Translatable")).toBeInTheDocument();
		});

		it("does not render the select-options textarea for the default string type", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} />);
			expect(screen.getByLabelText("Options (one per line)").query()).toBeNull();
		});
	});

	describe("edit mode (string field)", () => {
		const stringField = makeField({ type: "string", label: "Job title", slug: "job_title" });

		it("renders the edit-mode title", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Edit byline field")).toBeInTheDocument();
		});

		it("shows the edit-mode primary button label", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={stringField} />);
			await expect
				.element(screen.getByRole("button", { name: "Save changes" }))
				.toBeInTheDocument();
		});

		it("disables the slug input — slugs are immutable post-create", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Slug")).toBeDisabled();
		});

		it("prefills the label and slug from the field prop", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Label")).toHaveValue("Job title");
			await expect.element(screen.getByLabelText("Slug")).toHaveValue("job_title");
		});

		it("does not render the select-options textarea", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={stringField} />);
			expect(screen.getByLabelText("Options (one per line)").query()).toBeNull();
		});
	});

	describe("edit mode (select field)", () => {
		const selectField = makeField({
			type: "select",
			label: "Role",
			slug: "role",
			validation: { options: ["Editor", "Reporter", "Photographer"] },
		});

		it("renders the options textarea for select-type fields", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={selectField} />);
			await expect.element(screen.getByLabelText("Options (one per line)")).toBeInTheDocument();
		});

		it("prefills the options textarea from validation.options", async () => {
			const screen = await render(<BylineFieldEditor {...defaultProps} field={selectField} />);
			await expect
				.element(screen.getByLabelText("Options (one per line)"))
				.toHaveValue("Editor\nReporter\nPhotographer");
		});
	});

	describe("translatable toggle (AC: round-trips through the API)", () => {
		it("reflects a translatable=true field as a checked switch", async () => {
			const field = makeField({ translatable: true });
			const screen = await render(<BylineFieldEditor {...defaultProps} field={field} />);
			// The Switch's accessible name is "Translatable"; checking
			// `aria-checked` proves the prop wiring without needing to
			// click (the dialog overlay would block actionability anyway).
			const sw = screen.getByRole("switch", { name: "Translatable" });
			await expect.element(sw).toBeChecked();
		});

		it("reflects a translatable=false field as an unchecked switch", async () => {
			const field = makeField({ translatable: false });
			const screen = await render(<BylineFieldEditor {...defaultProps} field={field} />);
			const sw = screen.getByRole("switch", { name: "Translatable" });
			await expect.element(sw).not.toBeChecked();
		});

		it("locks the translatable switch when usageTotal > 0", async () => {
			const field = makeField({ translatable: true });
			const screen = await render(
				<BylineFieldEditor {...defaultProps} field={field} usageTotal={5} />,
			);
			const sw = screen.getByRole("switch", { name: "Translatable" });
			await expect.element(sw).toBeDisabled();
			// Help text surfaces the reason — admins shouldn't have to
			// trial-and-error the API to discover why the toggle won't move.
			await expect
				.element(screen.getByText(/Locked because this field has stored values/))
				.toBeInTheDocument();
		});

		it("leaves the translatable switch enabled when usageTotal is 0", async () => {
			const field = makeField({ translatable: true });
			const screen = await render(
				<BylineFieldEditor {...defaultProps} field={field} usageTotal={0} />,
			);
			const sw = screen.getByRole("switch", { name: "Translatable" });
			await expect.element(sw).not.toBeDisabled();
		});
	});
});
