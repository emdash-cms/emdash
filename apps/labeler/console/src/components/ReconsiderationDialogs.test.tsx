import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { renderWithClient } from "../test/harness.js";
import { ReconsiderationNoteDialog } from "./ReconsiderationNoteDialog.js";
import { ReconsiderationResolveDialog } from "./ReconsiderationResolveDialog.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

const RECON_ID = "recon_test";
const SUBJECT_URI = "at://did:plc:x/com.emdashcms.experimental.package.release/rk1";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ReconsiderationNoteDialog", () => {
	it("threads the note and reason, keeping submit disabled until both are set", async () => {
		const addNote = vi.spyOn(apiClient, "addReconsiderationNote").mockResolvedValue({
			actionId: "oact_1",
			reconsiderationId: RECON_ID,
			noteId: "rnote_1",
			cts: "",
		});
		renderWithClient(
			<ReconsiderationNoteDialog
				open
				onOpenChange={() => {}}
				reconsiderationId={RECON_ID}
				subjectUri={SUBJECT_URI}
				invalidateKeys={[]}
			/>,
		);

		const submit = screen.getByRole("button", { name: "Add note" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		fireEvent.change(screen.getByPlaceholderText("A private note for the case thread"), {
			target: { value: "publisher contests the finding" },
		});
		expect(submit.disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText("Why this note is being recorded"), {
			target: { value: "recording the dispute" },
		});
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);

		await waitFor(() => {
			expect(addNote).toHaveBeenCalledWith(
				RECON_ID,
				expect.objectContaining({
					note: "publisher contests the finding",
					reason: "recording the dispute",
				}),
			);
		});
		expect(addNote.mock.calls[0]![1].idempotencyKey.length).toBeGreaterThan(0);
	});

	it("surfaces the server error message on failure", async () => {
		vi.spyOn(apiClient, "addReconsiderationNote").mockRejectedValue(new Error("boom"));
		renderWithClient(
			<ReconsiderationNoteDialog
				open
				onOpenChange={() => {}}
				reconsiderationId={RECON_ID}
				subjectUri={SUBJECT_URI}
				invalidateKeys={[]}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("A private note for the case thread"), {
			target: { value: "note" },
		});
		fireEvent.change(screen.getByPlaceholderText("Why this note is being recorded"), {
			target: { value: "reason" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add note" }));
		expect(await screen.findByText("boom")).toBeTruthy();
	});
});

describe("ReconsiderationResolveDialog", () => {
	it("resolves with the default granted outcome and reason, threading an idempotency key", async () => {
		const resolve = vi.spyOn(apiClient, "resolveReconsideration").mockResolvedValue({
			actionId: "oact_1",
			reconsiderationId: RECON_ID,
			outcome: "granted",
			uri: SUBJECT_URI,
			cid: "bafy",
			cts: "",
		});
		renderWithClient(
			<ReconsiderationResolveDialog
				open
				onOpenChange={() => {}}
				reconsiderationId={RECON_ID}
				subjectUri={SUBJECT_URI}
				invalidateKeys={[]}
			/>,
		);

		const submit = screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText("Why this outcome was reached"), {
			target: { value: "finding confirmed as false positive" },
		});
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledWith(
				RECON_ID,
				expect.objectContaining({
					outcome: "granted",
					reason: "finding confirmed as false positive",
				}),
			);
		});
		// No final note was entered, so the optional field is omitted from the body.
		expect(resolve.mock.calls[0]![1].note).toBeUndefined();
	});

	it("includes the optional final note when entered", async () => {
		const resolve = vi.spyOn(apiClient, "resolveReconsideration").mockResolvedValue({
			actionId: "oact_1",
			reconsiderationId: RECON_ID,
			outcome: "granted",
			uri: SUBJECT_URI,
			cid: "bafy",
			cts: "",
		});
		renderWithClient(
			<ReconsiderationResolveDialog
				open
				onOpenChange={() => {}}
				reconsiderationId={RECON_ID}
				subjectUri={SUBJECT_URI}
				invalidateKeys={[]}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("A closing note for the case thread"), {
			target: { value: "closing note" },
		});
		fireEvent.change(screen.getByPlaceholderText("Why this outcome was reached"), {
			target: { value: "reason" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledWith(
				RECON_ID,
				expect.objectContaining({ note: "closing note" }),
			);
		});
	});

	it("surfaces the server 409 already-resolved message inline", async () => {
		vi.spyOn(apiClient, "resolveReconsideration").mockRejectedValue(
			new Error("Reconsideration is already resolved"),
		);
		renderWithClient(
			<ReconsiderationResolveDialog
				open
				onOpenChange={() => {}}
				reconsiderationId={RECON_ID}
				subjectUri={SUBJECT_URI}
				invalidateKeys={[]}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("Why this outcome was reached"), {
			target: { value: "reason" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(await screen.findByText("Reconsideration is already resolved")).toBeTruthy();
	});
});
