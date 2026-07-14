import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import { apiClient } from "../api/client.js";
import { AssessmentActionDialog } from "../components/AssessmentActionDialog.js";
import { AutomationControl } from "../components/AutomationControl.js";
import { DeadLetterActions } from "../components/DeadLetterActions.js";
import { EmergencyActionDialog } from "../components/EmergencyActionDialog.js";
import { LabelActionDialog } from "../components/LabelActionDialog.js";
import { OverrideDialog } from "../components/OverrideDialog.js";
import { ASSESSMENT_GAMMA, SUBJECT_ALPHA } from "../fixtures/index.js";
import { RELEASE_ISSUABLE_LABELS } from "../labels.js";
import { ADMIN_IDENTITY, renderRoute, renderWithClient } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

beforeEach(() => {
	vi.spyOn(apiClient, "whoami").mockResolvedValue(ADMIN_IDENTITY);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const RELEASE_URI = "at://did:plc:x/com.emdashcms.experimental.package.release/rk1";

/** Kumo dialogs portal a Base UI focus-guard sentinel (role="button", no name)
 * into the body around the panel; scoping axe to the panel scans the console's
 * own dialog markup and not that framework artifact. */
async function expectDialogClean(role: "dialog" | "alertdialog") {
	const panel = await screen.findByRole(role);
	expect(await axe(panel)).toHaveNoViolations();
}

describe("axe: routes", () => {
	it("Dashboard", async () => {
		const { container } = renderRoute("/");
		await screen.findByRole("heading", { name: "Dashboard", level: 1 });
		await screen.findByRole("button", { name: "Pause ingestion" });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("AssessmentList", async () => {
		const { container } = renderRoute("/assessments");
		await screen.findByRole("heading", { name: "Assessments", level: 1 });
		await screen.findByRole("table");
		expect(await axe(container)).toHaveNoViolations();
	});

	it("AssessmentDetail", async () => {
		const { container } = renderRoute(`/assessments/${ASSESSMENT_GAMMA.id}`);
		await screen.findByRole("heading", { name: "Assessment", level: 1 });
		await screen.findByRole("button", { name: "Rerun" });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("SubjectHistory", async () => {
		const { container } = renderRoute(`/subjects/${encodeURIComponent(SUBJECT_ALPHA.uri)}`);
		await screen.findByRole("heading", { name: "Subject history", level: 1 });
		await screen.findByRole("heading", { name: "Emergency actions", level: 2 });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("AuditLog", async () => {
		const { container } = renderRoute("/audit");
		await screen.findByRole("heading", { name: "Audit log", level: 1 });
		await screen.findByText("Audit log not yet available");
		expect(await axe(container)).toHaveNoViolations();
	});

	it("DeadLetterQueue", async () => {
		const { container } = renderRoute("/dead-letters");
		await screen.findByRole("heading", { name: "Dead-letter queue", level: 1 });
		await screen.findByRole("button", { name: "Retry" });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("NotFound", async () => {
		const { container } = renderRoute("/no-such-page");
		await screen.findByRole("heading", { name: "Not found", level: 1 });
		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("axe: dialogs", () => {
	it("EmergencyActionDialog", async () => {
		renderWithClient(
			<EmergencyActionDialog
				open
				onOpenChange={() => {}}
				kind="takedown"
				mode="issue"
				subjectUri={RELEASE_URI}
				subjectConfirmationExpected="rk1"
				invalidateKeys={[]}
			/>,
		);
		await expectDialogClean("alertdialog");
	});

	it("OverrideDialog", async () => {
		renderWithClient(
			<OverrideDialog
				open
				onOpenChange={() => {}}
				assessmentId="asmt_1"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				blocks={["security-yanked"]}
				invalidateKeys={[]}
			/>,
		);
		await expectDialogClean("alertdialog");
	});

	it("AssessmentActionDialog", async () => {
		renderWithClient(
			<AssessmentActionDialog
				open
				onOpenChange={() => {}}
				mode="rerun"
				assessmentId="asmt_1"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				invalidateKeys={[]}
			/>,
		);
		await expectDialogClean("alertdialog");
	});

	it("LabelActionDialog", async () => {
		renderWithClient(
			<LabelActionDialog
				open
				onOpenChange={() => {}}
				mode="issue"
				subjectUri={RELEASE_URI}
				subjectCid="bafyfixture"
				issuable={RELEASE_ISSUABLE_LABELS}
				invalidateKeys={[]}
			/>,
		);
		await expectDialogClean("dialog");
	});

	it("AutomationControl pause dialog", async () => {
		renderWithClient(<AutomationControl paused={false} pausedReason={null} isAdmin />);
		fireEvent.click(screen.getByRole("button", { name: "Pause ingestion" }));
		await expectDialogClean("alertdialog");
	});

	it("DeadLetterActions retry dialog", async () => {
		renderWithClient(<DeadLetterActions deadLetterId={3} />);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		const panel = await screen.findByRole("alertdialog");
		await within(panel).findByText("Retry dead letter");
		expect(await axe(panel)).toHaveNoViolations();
	});
});
