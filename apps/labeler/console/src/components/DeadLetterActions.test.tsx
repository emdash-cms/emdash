import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { DeadLetterActions } from "./DeadLetterActions.js";

vi.mock("../api/client.js", () => ({
	apiClient: { retryDeadLetter: vi.fn(), quarantineDeadLetter: vi.fn() },
}));

const retryDeadLetter = vi.mocked(apiClient.retryDeadLetter);
const quarantineDeadLetter = vi.mocked(apiClient.quarantineDeadLetter);

function renderActions(id = 7) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<DeadLetterActions deadLetterId={id} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	retryDeadLetter.mockReset();
	quarantineDeadLetter.mockReset();
});

describe("DeadLetterActions", () => {
	it("retries through the required-reason dialog, threading id and reason", async () => {
		retryDeadLetter.mockResolvedValue({
			actionId: "oact_1",
			deadLetterId: 7,
			status: "retried",
			cts: "2026-07-13T00:00:00.000Z",
		});
		renderActions(7);

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		const submit = screen.getByRole("button", { name: "Confirm retry" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		fireEvent.change(screen.getByPlaceholderText("Why this event is being re-driven"), {
			target: { value: "transient PDS outage cleared" },
		});
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);

		await waitFor(() => {
			expect(retryDeadLetter).toHaveBeenCalledWith(
				7,
				expect.objectContaining({ reason: "transient PDS outage cleared" }),
			);
		});
		expect(quarantineDeadLetter).not.toHaveBeenCalled();
	});

	it("quarantines through the required-reason dialog", async () => {
		quarantineDeadLetter.mockResolvedValue({
			actionId: "oact_2",
			deadLetterId: 7,
			status: "quarantined",
			cts: "2026-07-13T00:00:00.000Z",
		});
		renderActions(7);

		fireEvent.click(screen.getByRole("button", { name: "Quarantine" }));
		fireEvent.change(screen.getByPlaceholderText("Why this event is being quarantined"), {
			target: { value: "not a real release" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Confirm quarantine" }));

		await waitFor(() => {
			expect(quarantineDeadLetter).toHaveBeenCalledWith(
				7,
				expect.objectContaining({ reason: "not a real release" }),
			);
		});
		expect(retryDeadLetter).not.toHaveBeenCalled();
	});
});
