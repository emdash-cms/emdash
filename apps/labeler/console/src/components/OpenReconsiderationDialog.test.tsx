import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { ASSESSMENT_GAMMA } from "../fixtures/index.js";
import { renderRoute } from "../test/harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

const DETAIL_PATH = `/assessments/${ASSESSMENT_GAMMA.id}`;

async function openTheDialog(): Promise<HTMLElement> {
	renderRoute(DETAIL_PATH);
	fireEvent.click(await screen.findByRole("button", { name: "Open reconsideration" }));
	return screen.findByRole("alertdialog");
}

describe("OpenReconsiderationDialog (via AssessmentDetail)", () => {
	it("opens a case for this assessment and navigates to the new case detail", async () => {
		const open = vi.spyOn(apiClient, "openReconsideration").mockResolvedValue({
			actionId: "oact_1",
			reconsiderationId: "recon_new",
			uri: ASSESSMENT_GAMMA.uri,
			cid: ASSESSMENT_GAMMA.cid,
			triggeringAssessmentId: ASSESSMENT_GAMMA.id,
			cts: "",
		});
		const dialog = await openTheDialog();

		fireEvent.change(
			within(dialog).getByPlaceholderText("Why this assessment is being reconsidered"),
			{ target: { value: "publisher appealed the block" } },
		);
		fireEvent.change(within(dialog).getByPlaceholderText("Why this case is being opened"), {
			target: { value: "opening for review" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Open reconsideration" }));

		await waitFor(() => {
			expect(open).toHaveBeenCalledWith(
				expect.objectContaining({
					assessmentId: ASSESSMENT_GAMMA.id,
					note: "publisher appealed the block",
					reason: "opening for review",
				}),
			);
		});
		// Navigation lands on the new case; getReconsideration("recon_new") is absent
		// from the fixtures, so the detail resolves not-found — proof we navigated.
		expect(await screen.findByText("Reconsideration not found.")).toBeTruthy();
	});

	it("surfaces the server 409 open-exists message inline", async () => {
		vi.spyOn(apiClient, "openReconsideration").mockRejectedValue(
			new Error("An open reconsideration already exists for this subject"),
		);
		const dialog = await openTheDialog();

		fireEvent.change(
			within(dialog).getByPlaceholderText("Why this assessment is being reconsidered"),
			{ target: { value: "note" } },
		);
		fireEvent.change(within(dialog).getByPlaceholderText("Why this case is being opened"), {
			target: { value: "reason" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Open reconsideration" }));

		expect(
			await within(dialog).findByText("An open reconsideration already exists for this subject"),
		).toBeTruthy();
	});
});
