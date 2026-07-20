import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { SUBJECT_ALPHA } from "../fixtures/index.js";
import { ADMIN_IDENTITY, renderRoute, REVIEWER_IDENTITY } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

function asRole(identity: typeof ADMIN_IDENTITY) {
	vi.spyOn(apiClient, "whoami").mockResolvedValue(identity);
}

describe("cosmetic admin gating (server stays authoritative)", () => {
	describe("SubjectHistory emergency actions", () => {
		const path = `/subjects/${encodeURIComponent(SUBJECT_ALPHA.uri)}`;

		it("renders for an admin", async () => {
			asRole(ADMIN_IDENTITY);
			renderRoute(path);
			await screen.findByRole("heading", { name: "Subject history", level: 1 });
			expect(await screen.findByRole("heading", { name: "Emergency actions" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Take down record" })).toBeTruthy();
		});

		it("is hidden from a reviewer", async () => {
			asRole(REVIEWER_IDENTITY);
			renderRoute(path);
			await screen.findByRole("heading", { name: "Subject history", level: 1 });
			await screen.findByRole("button", { name: "Issue record label" });
			expect(screen.queryByRole("heading", { name: "Emergency actions" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Take down record" })).toBeNull();
		});
	});

	describe("Dashboard automation control", () => {
		it("shows the pause toggle to an admin", async () => {
			asRole(ADMIN_IDENTITY);
			renderRoute("/");
			await screen.findByRole("heading", { name: "Dashboard", level: 1 });
			expect(await screen.findByRole("button", { name: "Pause ingestion" })).toBeTruthy();
		});

		it("hides the pause toggle from a reviewer", async () => {
			asRole(REVIEWER_IDENTITY);
			renderRoute("/");
			await screen.findByRole("heading", { name: "Dashboard", level: 1 });
			await screen.findByText("Active");
			expect(screen.queryByRole("button", { name: "Pause ingestion" })).toBeNull();
		});
	});

	describe("DeadLetterQueue actions", () => {
		it("renders retry/quarantine for an admin", async () => {
			asRole(ADMIN_IDENTITY);
			renderRoute("/dead-letters");
			await screen.findByRole("heading", { name: "Dead-letter queue", level: 1 });
			expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Quarantine" })).toBeTruthy();
		});

		it("hides them from a reviewer", async () => {
			asRole(REVIEWER_IDENTITY);
			renderRoute("/dead-letters");
			await screen.findByRole("heading", { name: "Dead-letter queue", level: 1 });
			await screen.findByRole("table");
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Quarantine" })).toBeNull();
		});
	});
});
