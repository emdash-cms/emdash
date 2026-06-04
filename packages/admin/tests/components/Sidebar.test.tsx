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

import { PuzzlePiece } from "@phosphor-icons/react";
import { describe, it, expect } from "vitest";

import {
	BYLINE_SCHEMA_NAV_ITEM,
	filterNavItemsByRole,
	resolveNavIcon,
	toPhosphorIconName,
} from "../../src/components/Sidebar";

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
	it("aliases documented lucide-style names to their Phosphor component", async () => {
		// Names the docs/templates use that DON'T match Phosphor's own
		// naming. These must resolve to a real Phosphor export — assert
		// against the live package so a wrong alias fails here.
		expect(toPhosphorIconName("settings")).toBe("Gear");
		expect(toPhosphorIconName("chart")).toBe("ChartBar");
		expect(toPhosphorIconName("award")).toBe("Medal");
		const mod: Record<string, unknown> = await import("@phosphor-icons/react");
		for (const name of ["settings", "chart", "award", "grid", "dashboard"]) {
			expect(mod[toPhosphorIconName(name)]).toBeDefined();
		}
	});

	it("converts kebab/snake/space names to PascalCase", () => {
		// The general path: any Phosphor icon by its own kebab name.
		expect(toPhosphorIconName("chart-bar")).toBe("ChartBar");
		expect(toPhosphorIconName("clock-counter-clockwise")).toBe("ClockCounterClockwise");
		expect(toPhosphorIconName("trophy")).toBe("Trophy");
		expect(toPhosphorIconName("crop")).toBe("Crop");
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

	it("returns a stable (memoized) lazy component for a named icon", () => {
		// React.lazy identity must be stable across renders, otherwise
		// the icon remounts and re-suspends every render. Repeated calls
		// for the same name must return the same component reference.
		const first = resolveNavIcon("trophy");
		const second = resolveNavIcon("trophy");
		expect(first).toBe(second);
		// It's a lazy component, not the synchronous fallback.
		expect(first).not.toBe(PuzzlePiece);
		expect((first as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.lazy"));
	});
});
