import { i18n } from "@lingui/core";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBrandingProvider } from "../src/lib/admin-branding-context.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.js";

vi.mock("../src/components/LoginPage", () => ({ LoginPage: () => <div>Login</div> }));
vi.mock("../src/components/SetupWizard", () => ({ SetupWizard: () => <div>Setup</div> }));

beforeEach(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("standalone browser titles", () => {
	it("preserves configured branding on auth pages and reacts to navigation and brand changes", async () => {
		const router = createAdminRouter(createTestQueryClient());
		await router.navigate({ to: "/login" });
		const screen = await render(
			<AdminBrandingProvider adminBranding={{ siteName: "Acme" }}>
				<RouterProvider router={router} />
			</AdminBrandingProvider>,
		);
		await expect.poll(() => document.title).toBe("Log in · Acme");
		await router.navigate({ to: "/setup" });
		await expect.poll(() => document.title).toBe("Setup · Acme");
		await screen.rerender(
			<AdminBrandingProvider adminBranding={{ siteName: "New Brand" }}>
				<RouterProvider router={router} />
			</AdminBrandingProvider>,
		);
		await expect.poll(() => document.title).toBe("Setup · New Brand");
	});

	it("uses EmDash when no branding is configured", async () => {
		const router = createAdminRouter(createTestQueryClient());
		await router.navigate({ to: "/login" });
		await render(<RouterProvider router={router} />);
		await expect.poll(() => document.title).toBe("Log in · EmDash");
	});
});
