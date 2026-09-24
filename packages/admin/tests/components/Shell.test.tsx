import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "../../src/components/Shell";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", () => ({
	useMatches: ({ select }: { select: (matches: unknown[]) => boolean }) =>
		select([{ staticData: { fullBleed: false } }]),
}));

const mocks = vi.hoisted(() => ({ user: null as null | { role: number } }));

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: mocks.user }),
}));

vi.mock("../../src/locales/useLocale.js", () => ({
	useLocale: () => ({ locale: "en" }),
}));

vi.mock("../../src/components/Sidebar", () => ({
	Sidebar: {
		Provider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	},
	SidebarNav: () => <nav />,
}));

vi.mock("../../src/components/Header", () => ({ Header: () => <header /> }));
vi.mock("../../src/components/WelcomeModal", () => ({ WelcomeModal: () => null }));
vi.mock("../../src/components/AdminCommandPalette", () => ({ AdminCommandPalette: () => null }));

const manifest = {
	collections: {},
	plugins: {},
	taxonomies: [],
};

describe("Shell", () => {
	beforeEach(() => {
		mocks.user = null;
		localStorage.clear();
	});

	it("sets the admin page canvas to the elevated surface", async () => {
		await render(
			<Shell manifest={manifest}>
				<div>Page content</div>
			</Shell>,
		);

		expect(document.querySelector("main")).toHaveClass("bg-kumo-elevated");
	});

	it("does not show marketplace migration guidance outside the dashboard", async () => {
		const screen = await render(
			<Shell manifest={{ ...manifest, marketplace: true }}>
				<div>Page content</div>
			</Shell>,
		);

		await expect
			.element(screen.getByText("Marketplace configuration is deprecated"))
			.not.toBeInTheDocument();
	});

	it("stores localized labels for the cache-safe client toolbar bootstrap", async () => {
		mocks.user = { role: 30 };
		await render(
			<Shell manifest={manifest}>
				<div>Page content</div>
			</Shell>,
		);

		expect(JSON.parse(localStorage.getItem("emdash-toolbar-labels") ?? "null")).toEqual({
			editMode: "Edit",
			hideToolbar: "Hide toolbar",
		});
	});
});
