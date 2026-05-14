/**
 * Quick test to verify menu-sync exports work.
 */

import { describe, it, expect } from "vitest";

import {
	computeMenuSyncDiff,
	applyMenuSyncDiff,
	syncSidebarToMenu,
} from "../../../src/api/handlers/menu-sync.js";
import {
	syncCollectionToMenu,
	removeCollectionFromMenu,
} from "../../../src/api/handlers/schema.js";

describe("Menu Sync Exports", () => {
	it("exports syncCollectionToMenu as a function", () => {
		expect(typeof syncCollectionToMenu).toBe("function");
	});

	it("exports removeCollectionFromMenu as a function", () => {
		expect(typeof removeCollectionFromMenu).toBe("function");
	});

	it("exports computeMenuSyncDiff as a function", () => {
		expect(typeof computeMenuSyncDiff).toBe("function");
	});

	it("exports applyMenuSyncDiff as a function", () => {
		expect(typeof applyMenuSyncDiff).toBe("function");
	});

	it("exports syncSidebarToMenu as a function", () => {
		expect(typeof syncSidebarToMenu).toBe("function");
	});
});
