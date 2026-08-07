import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Shell } from "../../src/components/Shell";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", () => ({
	useMatches: ({ select }: { select: (matches: unknown[]) => boolean }) =>
		select([{ staticData: { fullBleed: false } }]),
}));

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: null }),
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
	it("sets the admin page canvas to the elevated surface", async () => {
		await render(
			<Shell manifest={manifest}>
				<div>Page content</div>
			</Shell>,
		);

		expect(document.querySelector("main")).toHaveClass("bg-kumo-elevated");
	});
});
