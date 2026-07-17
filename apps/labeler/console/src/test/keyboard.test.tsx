import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { AssessmentActionDialog } from "../components/AssessmentActionDialog.js";
import { AutomationControl } from "../components/AutomationControl.js";
import { DeadLetterActions } from "../components/DeadLetterActions.js";
import { EmergencyActionDialog } from "../components/EmergencyActionDialog.js";
import { LabelActionDialog } from "../components/LabelActionDialog.js";
import { OverrideDialog } from "../components/OverrideDialog.js";
import { ReconsiderationNoteDialog } from "../components/ReconsiderationNoteDialog.js";
import { ReconsiderationResolveDialog } from "../components/ReconsiderationResolveDialog.js";
import { RELEASE_ISSUABLE_LABELS } from "../labels.js";
import { renderWithClient } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

const RELEASE_URI = "at://did:plc:x/com.emdashcms.experimental.package.release/rk1";

interface DialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Renders a real trigger button alongside a controlled dialog so the tests can
 * exercise the full open -> trap -> Escape -> restore cycle Kumo's Dialog owns. */
function renderTriggered(build: (props: DialogProps) => ReactElement) {
	const onOpenChange = vi.fn();
	function Wrapper() {
		const [open, setOpen] = useState(false);
		return (
			<>
				<button type="button" onClick={() => setOpen(true)}>
					Open dialog
				</button>
				{build({
					open,
					onOpenChange: (next) => {
						onOpenChange(next);
						setOpen(next);
					},
				})}
			</>
		);
	}
	renderWithClient(<Wrapper />);
	return { onOpenChange };
}

const CASES: {
	name: string;
	role: "dialog" | "alertdialog";
	build: (props: DialogProps) => ReactElement;
}[] = [
	{
		name: "EmergencyActionDialog",
		role: "alertdialog",
		build: (props) => (
			<EmergencyActionDialog
				{...props}
				kind="takedown"
				mode="issue"
				subjectUri={RELEASE_URI}
				subjectConfirmationExpected="rk1"
				invalidateKeys={[]}
			/>
		),
	},
	{
		name: "OverrideDialog",
		role: "alertdialog",
		build: (props) => (
			<OverrideDialog
				{...props}
				assessmentId="asmt_1"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				blocks={["security-yanked"]}
				invalidateKeys={[]}
			/>
		),
	},
	{
		name: "AssessmentActionDialog",
		role: "alertdialog",
		build: (props) => (
			<AssessmentActionDialog
				{...props}
				mode="rerun"
				assessmentId="asmt_1"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				invalidateKeys={[]}
			/>
		),
	},
	{
		name: "LabelActionDialog",
		role: "dialog",
		build: (props) => (
			<LabelActionDialog
				{...props}
				mode="issue"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				issuable={RELEASE_ISSUABLE_LABELS}
				invalidateKeys={[]}
			/>
		),
	},
	{
		name: "ReconsiderationNoteDialog",
		role: "alertdialog",
		build: (props) => (
			<ReconsiderationNoteDialog
				{...props}
				reconsiderationId="recon_1"
				subjectUri={RELEASE_URI}
				invalidateKeys={[]}
			/>
		),
	},
	{
		name: "ReconsiderationResolveDialog",
		role: "alertdialog",
		build: (props) => (
			<ReconsiderationResolveDialog
				{...props}
				reconsiderationId="recon_1"
				subjectUri={RELEASE_URI}
				invalidateKeys={[]}
			/>
		),
	},
];

describe("keyboard: dialog focus management", () => {
	it.each(CASES)(
		"$name moves focus in on open and Escape closes it, restoring focus",
		async ({ role, build }) => {
			const user = userEvent.setup();
			const { onOpenChange } = renderTriggered(build);

			const trigger = screen.getByRole("button", { name: "Open dialog" });
			await user.click(trigger);

			const dialog = await screen.findByRole(role);
			await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

			await user.keyboard("{Escape}");
			await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
			expect(onOpenChange).toHaveBeenCalledWith(false);
			await waitFor(() => expect(document.activeElement).toBe(trigger));
		},
	);
});

describe("keyboard: self-contained action controls", () => {
	it("AutomationControl restores focus to its trigger after Escape", async () => {
		const user = userEvent.setup();
		renderWithClient(<AutomationControl paused={false} pausedReason={null} isAdmin />);

		const trigger = screen.getByRole("button", { name: "Pause ingestion" });
		await user.click(trigger);
		const dialog = await screen.findByRole("alertdialog");
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("DeadLetterActions runs its primary action from the keyboard", async () => {
		const user = userEvent.setup();
		const retry = vi
			.spyOn(apiClient, "retryDeadLetter")
			.mockResolvedValue({ actionId: "oact_1", deadLetterId: 3, status: "retried", cts: "" });
		renderWithClient(<DeadLetterActions deadLetterId={3} />);

		const trigger = screen.getByRole("button", { name: "Retry" });
		await user.click(trigger);
		await screen.findByRole("alertdialog");

		await user.type(
			screen.getByPlaceholderText("Why this event is being re-driven"),
			"PDS recovered",
		);
		const submit = screen.getByRole("button", { name: "Confirm retry" });
		submit.focus();
		await user.keyboard("{Enter}");

		await waitFor(() =>
			expect(retry).toHaveBeenCalledWith(3, expect.objectContaining({ reason: "PDS recovered" })),
		);
	});
});
