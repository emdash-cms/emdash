import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import type { EmergencyActionInput, EmergencyActionKind } from "../api/types.js";
import { EmergencyActionDialog } from "./EmergencyActionDialog.js";

vi.mock("../api/client.js", () => ({
	apiClient: { emergencyAction: vi.fn() },
}));

const emergencyAction = vi.mocked(apiClient.emergencyAction);

const RELEASE_URI = "at://did:plc:x/com.emdashcms.experimental.package.release/rk1";

interface RenderOverrides {
	kind?: EmergencyActionKind;
	mode?: "issue" | "retract";
	subjectUri?: string;
	subjectConfirmationExpected?: string;
}

function renderDialog(overrides: RenderOverrides = {}) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<EmergencyActionDialog
				open
				onOpenChange={onOpenChange}
				kind={overrides.kind ?? "takedown"}
				mode={overrides.mode ?? "issue"}
				subjectUri={overrides.subjectUri ?? RELEASE_URI}
				subjectConfirmationExpected={overrides.subjectConfirmationExpected ?? "rk1"}
				invalidateKeys={[]}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange };
}

function fill(reason: string, subject: string, intent: string) {
	fireEvent.change(screen.getByPlaceholderText("Why this emergency action is being taken"), {
		target: { value: reason },
	});
	fireEvent.change(screen.getByPlaceholderText("rk1"), { target: { value: subject } });
	fireEvent.change(screen.getByPlaceholderText("CONFIRM TAKEDOWN"), { target: { value: intent } });
}

afterEach(() => {
	emergencyAction.mockReset();
});

describe("EmergencyActionDialog", () => {
	it("keeps submit disabled until the reason and both typed confirmations match", () => {
		renderDialog();
		const submit = screen.getByRole("button", { name: "Take down" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		fill("incident", "rk1", "CONFIRM TAKEDOWN");
		expect(submit.disabled).toBe(false);
	});

	it("submits with both ceremony fields once they match", async () => {
		emergencyAction.mockResolvedValue({
			actionId: "oact_1",
			val: "!takedown",
			uri: RELEASE_URI,
			cid: null,
			neg: false,
			cts: "2026-07-13T00:00:00.000Z",
			effect: "redact",
		});
		renderDialog();
		fill("incident", "rk1", "CONFIRM TAKEDOWN");
		fireEvent.click(screen.getByRole("button", { name: "Take down" }));

		await waitFor(() => {
			expect(emergencyAction).toHaveBeenCalledWith(
				"takedown",
				"issue",
				expect.objectContaining<Partial<EmergencyActionInput>>({
					uri: RELEASE_URI,
					subjectConfirmation: "rk1",
					intent: "CONFIRM TAKEDOWN",
					reason: "incident",
				}),
			);
		});
	});

	it("rejects a wrong intent phrase (disabled + error, never submits)", () => {
		renderDialog();
		fill("incident", "rk1", "CONFIRM COMPROMISE");
		const submit = screen.getByRole("button", { name: "Take down" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(screen.getByText("Does not match the required phrase")).toBeTruthy();
		fireEvent.click(submit);
		expect(emergencyAction).not.toHaveBeenCalled();
	});

	it("rejects a wrong subject confirmation (disabled + error)", () => {
		renderDialog();
		fireEvent.change(screen.getByPlaceholderText("Why this emergency action is being taken"), {
			target: { value: "incident" },
		});
		fireEvent.change(screen.getByPlaceholderText("rk1"), { target: { value: "wrong-rkey" } });
		fireEvent.change(screen.getByPlaceholderText("CONFIRM TAKEDOWN"), {
			target: { value: "CONFIRM TAKEDOWN" },
		});
		const submit = screen.getByRole("button", { name: "Take down" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(screen.getByText("Does not match the subject")).toBeTruthy();
	});

	it("uses the CONFIRM RETRACT intent and retract copy in retract mode", () => {
		renderDialog({ mode: "retract" });
		expect(screen.getByRole("button", { name: "Retract takedown" })).toBeTruthy();
		expect(screen.getByPlaceholderText("CONFIRM RETRACT")).toBeTruthy();
	});

	it("uses the CONFIRM COMPROMISE intent for publisher-compromised", () => {
		renderDialog({
			kind: "publisher-compromised",
			subjectUri: "did:plc:publisher000",
			subjectConfirmationExpected: "publisher000",
		});
		expect(screen.getByText("Mark publisher compromised")).toBeTruthy();
		expect(screen.getByPlaceholderText("CONFIRM COMPROMISE")).toBeTruthy();
	});
});
