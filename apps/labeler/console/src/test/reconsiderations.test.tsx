import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { RECONSIDERATION_BETA_GRANTED, RECONSIDERATION_GAMMA_OPEN } from "../fixtures/index.js";
import { renderRoute, REVIEWER_IDENTITY } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Reconsiderations list", () => {
	it("renders a case per row with its state and outcome, linking to the detail", async () => {
		renderRoute("/reconsiderations");
		await screen.findByRole("heading", { name: "Reconsiderations", level: 1 });
		const table = await screen.findByRole("table");

		const openLink = within(table).getByRole("link", {
			name: RECONSIDERATION_GAMMA_OPEN.subjectUri.split("/").pop(),
		});
		expect(openLink.getAttribute("href")).toContain(
			`/reconsiderations/${RECONSIDERATION_GAMMA_OPEN.id}`,
		);
		expect(within(table).getByText("Open")).toBeTruthy();
		expect(within(table).getByText("Granted")).toBeTruthy();
	});

	it("shows the empty state when there are no cases", async () => {
		vi.spyOn(apiClient, "listReconsiderations").mockResolvedValue({ items: [] });
		renderRoute("/reconsiderations");
		await screen.findByRole("heading", { name: "Reconsiderations", level: 1 });
		expect(await screen.findByText("No reconsiderations.")).toBeTruthy();
	});
});

describe("Reconsideration detail", () => {
	it("shows the note thread and offers Resolve for an open case", async () => {
		vi.spyOn(apiClient, "whoami").mockResolvedValue(REVIEWER_IDENTITY);
		renderRoute(`/reconsiderations/${RECONSIDERATION_GAMMA_OPEN.id}`);
		await screen.findByRole("heading", { name: "Reconsideration", level: 1 });

		expect(await screen.findByRole("button", { name: "Add note" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
		expect(screen.getByText(/Publisher disputes the malware flag/)).toBeTruthy();
		// The triggering assessment cross-links to its detail.
		const link = screen.getByRole("link", {
			name: RECONSIDERATION_GAMMA_OPEN.triggeringAssessmentId,
		});
		expect(link.getAttribute("href")).toContain(
			`/assessments/${RECONSIDERATION_GAMMA_OPEN.triggeringAssessmentId}`,
		);
	});

	it("hides Resolve for a resolved case and shows its outcome", async () => {
		vi.spyOn(apiClient, "whoami").mockResolvedValue(REVIEWER_IDENTITY);
		renderRoute(`/reconsiderations/${RECONSIDERATION_BETA_GRANTED.id}`);
		await screen.findByRole("heading", { name: "Reconsideration", level: 1 });

		await screen.findByRole("button", { name: "Add note" });
		expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
		expect(screen.getByText("Granted")).toBeTruthy();
	});

	it("renders a not-found state for an unknown case id", async () => {
		vi.spyOn(apiClient, "getReconsideration").mockResolvedValue(null);
		renderRoute("/reconsiderations/recon_missing");
		expect(await screen.findByText("Reconsideration not found.")).toBeTruthy();
	});
});
