/**
 * Sidebar nav invariants — Phase 5 visibility regression guard for the
 * "Byline Schema" entry (Discussion #1174).
 *
 * AC: "Admin sees the 'Byline Schema' sidebar entry; Editor does not."
 *
 * The full SidebarNav component is hard to test against because Kumo's
 * Sidebar primitive portals its rendered content to `document.body`,
 * applies collapse-state CSS that hides labels at narrow viewports
 * (the vitest-browser-react default), and runs Radix-style provider
 * choreography that doesn't surface anchors via `screen.container`.
 * Mounting tests against it produced inconsistent results across role
 * cases that should have been symmetric.
 *
 * Instead, the source `Sidebar.tsx` exports two pure artefacts:
 *
 *   - `BYLINE_SCHEMA_NAV_ITEM` — the route + minRole pairing used
 *     verbatim inside the runtime `adminItems` array.
 *   - `filterNavItemsByRole` — the pure role filter applied to every
 *     nav group.
 *
 * Together they cover the AC without DOM coupling: the constant pins
 * the contract, the filter pins the gate.
 */

import { PuzzlePiece, Gear, Trophy, ClockCounterClockwise } from "@phosphor-icons/react";
import * as React from "react";
import { describe, it, expect } from "vitest";

import {
	BYLINE_SCHEMA_NAV_ITEM,
	filterNavItemsByRole,
	resolveNavIcon,
	toPhosphorIconName,
} from "../../src/components/Sidebar";
import { render } from "../utils/render.tsx";

// Mirror @emdash-cms/auth Role levels. Kept inline (matching Sidebar.tsx)
// to avoid a runtime dependency just to read two numeric constants.
const ROLE_SUBSCRIBER = 10;
const ROLE_CONTRIBUTOR = 20;
const ROLE_AUTHOR = 30;
const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

describe("BYLINE_SCHEMA_NAV_ITEM invariants", () => {
	it("points to the /byline-schema route", () => {
		expect(BYLINE_SCHEMA_NAV_ITEM.to).toBe("/byline-schema");
	});

	it("gates on ROLE_ADMIN — editors and below must not see it", () => {
		// If anyone drops this to ROLE_EDITOR (40), editors gain
		// access to admin-only schema management via the sidebar.
		// Keep this asserting the literal 50 (not the constant) so a
		// rename like `ROLE_ADMIN = 40` would also fail the test.
		expect(BYLINE_SCHEMA_NAV_ITEM.minRole).toBe(50);
	});
});

describe("filterNavItemsByRole", () => {
	const items = [
		{ to: "/", minRole: undefined },
		{ to: "/bylines", minRole: ROLE_EDITOR },
		{ to: "/byline-schema", minRole: ROLE_ADMIN },
	];

	it("passes items without minRole at every role", () => {
		for (const role of [ROLE_SUBSCRIBER, ROLE_CONTRIBUTOR, ROLE_AUTHOR, ROLE_EDITOR, ROLE_ADMIN]) {
			expect(filterNavItemsByRole(items, role).map((i) => i.to)).toContain("/");
		}
	});

	it("excludes /byline-schema for EDITOR", () => {
		// Direct check of the AC: an Editor must not see the entry.
		const visible = filterNavItemsByRole(items, ROLE_EDITOR).map((i) => i.to);
		expect(visible).not.toContain("/byline-schema");
	});

	it("excludes /byline-schema for AUTHOR, CONTRIBUTOR, SUBSCRIBER", () => {
		for (const role of [ROLE_SUBSCRIBER, ROLE_CONTRIBUTOR, ROLE_AUTHOR]) {
			const visible = filterNavItemsByRole(items, role).map((i) => i.to);
			expect(visible).not.toContain("/byline-schema");
		}
	});

	it("includes /byline-schema for ADMIN", () => {
		const visible = filterNavItemsByRole(items, ROLE_ADMIN).map((i) => i.to);
		expect(visible).toContain("/byline-schema");
	});

	it("treats role=0 (unauthenticated / pre-fetch) as below every gate", () => {
		// SidebarNav falls back to `userRole ?? 0` during the brief
		// load window before `useCurrentUser` resolves. The filter
		// must strip every gated entry at role=0.
		const visible = filterNavItemsByRole(items, 0).map((i) => i.to);
		expect(visible).toEqual(["/"]);
	});
});

describe("toPhosphorIconName", () => {
	it("converts kebab/snake/space names to PascalCase (the lazy-path key)", () => {
		// Any Phosphor icon is reachable by its own kebab name.
		expect(toPhosphorIconName("chart-bar")).toBe("ChartBar");
		expect(toPhosphorIconName("clock-counter-clockwise")).toBe("ClockCounterClockwise");
		expect(toPhosphorIconName("magnifying-glass")).toBe("MagnifyingGlass");
		expect(toPhosphorIconName("heart")).toBe("Heart");
	});
});

describe("resolveNavIcon", () => {
	it("falls back to PuzzlePiece when no icon is provided", () => {
		// `icon` is optional on adminPages; an omitted value is the
		// common case and must resolve synchronously to the default
		// (no Suspense boundary needed for the icon-less page).
		expect(resolveNavIcon(undefined)).toBe(PuzzlePiece);
		expect(resolveNavIcon("")).toBe(PuzzlePiece);
	});

	it("resolves common/documented names synchronously from the static map", () => {
		// These ship in the main bundle and must NOT be lazy — the
		// everyday case never loads the full Phosphor set. Includes a
		// lucide-style alias (`settings` → Gear) and a Phosphor-named one.
		expect(resolveNavIcon("settings")).toBe(Gear);
		expect(resolveNavIcon("trophy")).toBe(Trophy);
		expect(resolveNavIcon("history")).toBe(ClockCounterClockwise);
	});

	it("returns a stable (memoized) lazy component for a name outside the map", () => {
		// `heart` isn't in the static map, so it takes the lazy path.
		// React.lazy identity must be stable across renders, otherwise the
		// icon remounts and re-suspends — repeated calls return the same ref.
		const first = resolveNavIcon("heart");
		const second = resolveNavIcon("heart");
		expect(first).toBe(second);
		expect(first).not.toBe(PuzzlePiece);
		expect((first as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.lazy"));
	});

	it("renders the PuzzlePiece fallback for a name that doesn't exist in Phosphor", async () => {
		// The lazy path resolves `mod[componentName] ?? PuzzlePiece`. Drive
		// it through a real render (not the Kumo Sidebar — just the icon) and
		// confirm the rendered glyph IS PuzzlePiece by comparing the SVG body
		// against a directly-rendered reference.
		const Unknown = resolveNavIcon("definitely-not-a-real-icon-xyz");
		const screen = await render(
			<React.Suspense fallback={<span>loading</span>}>
				<Unknown data-testid="resolved" />
				<PuzzlePiece data-testid="expected" />
			</React.Suspense>,
		);
		const resolved = screen.getByTestId("resolved");
		await expect.element(resolved).toBeInTheDocument();
		expect(resolved.element().innerHTML).toBe(screen.getByTestId("expected").element().innerHTML);
	});
});
