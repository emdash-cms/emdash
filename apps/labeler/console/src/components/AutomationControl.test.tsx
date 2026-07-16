import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { AutomationControl } from "./AutomationControl.js";

vi.mock("../api/client.js", () => ({
	apiClient: { pauseAutomation: vi.fn(), resumeAutomation: vi.fn() },
}));

const pauseAutomation = vi.mocked(apiClient.pauseAutomation);
const resumeAutomation = vi.mocked(apiClient.resumeAutomation);

interface RenderOverrides {
	paused?: boolean;
	pausedReason?: string | null;
	isAdmin?: boolean;
}

function renderControl(overrides: RenderOverrides = {}) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AutomationControl
				paused={overrides.paused ?? false}
				pausedReason={overrides.pausedReason ?? null}
				isAdmin={overrides.isAdmin ?? true}
			/>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	pauseAutomation.mockReset();
	resumeAutomation.mockReset();
});

describe("AutomationControl", () => {
	it("shows Active and pauses through the required-reason dialog for an admin", async () => {
		pauseAutomation.mockResolvedValue({
			actionId: "oact_1",
			paused: true,
			reason: "incident",
			cts: "2026-07-13T00:00:00.000Z",
		});
		renderControl({ paused: false });
		expect(screen.getByText("Active")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Pause ingestion" }));
		const submit = screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		fireEvent.change(screen.getByPlaceholderText("Why ingestion is being paused"), {
			target: { value: "incident" },
		});
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);

		await waitFor(() => {
			expect(pauseAutomation).toHaveBeenCalledWith(expect.objectContaining({ reason: "incident" }));
		});
		expect(resumeAutomation).not.toHaveBeenCalled();
	});

	it("shows Paused with the reason and resumes when paused", async () => {
		resumeAutomation.mockResolvedValue({
			actionId: "oact_2",
			paused: false,
			reason: "cleared",
			cts: "2026-07-13T00:00:00.000Z",
		});
		renderControl({ paused: true, pausedReason: "incident-42" });
		expect(screen.getByText("Paused")).toBeTruthy();
		expect(screen.getByText("incident-42")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Resume ingestion" }));
		fireEvent.change(screen.getByPlaceholderText("Why ingestion is being resumed"), {
			target: { value: "cleared" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Resume" }));

		await waitFor(() => {
			expect(resumeAutomation).toHaveBeenCalledWith(expect.objectContaining({ reason: "cleared" }));
		});
		expect(pauseAutomation).not.toHaveBeenCalled();
	});

	it("hides the toggle for a non-admin (server stays authoritative)", () => {
		renderControl({ paused: false, isAdmin: false });
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Pause ingestion" })).toBeNull();
	});
});
