import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/admin/App.js";
// @ts-ignore -- Lingui generates this module before the UI test runs.
import { messages } from "../../src/admin/locales/en/messages.mjs";

const api = vi.hoisted(() => ({
	getSession: vi.fn(),
	getHealth: vi.fn(),
	getAssessments: vi.fn(),
	getAssessment: vi.fn(),
	getIssuance: vi.fn(),
	getEvaluations: vi.fn(),
	getEvaluation: vi.fn(),
	getActivity: vi.fn(),
	assessmentAction: vi.fn(),
	setIssuance: vi.fn(),
	setTakedown: vi.fn(),
	startEvaluation: vi.fn(),
}));

vi.mock("../../src/admin/api.js", () => api);

beforeEach(() => {
	window.history.replaceState(null, "", "/_admin");
	i18n.loadAndActivate({ locale: "en", messages });
	api.getSession.mockResolvedValue({
		authenticated: true,
		identity: {
			kind: "human",
			principal: "reviewer@example.com",
			actorDid: "did:web:labels.emdashcms.com:operators:test",
			roles: ["reviewer"],
		},
	});
	api.getHealth.mockResolvedValue({
		service: "emdash-labeler",
		status: "ok",
		discovery: { ready: true },
		signing: { ready: true },
	});
	api.getAssessments.mockResolvedValue({ items: [] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("labeler admin application", () => {
	it("shows reviewer workflows without administrator controls", async () => {
		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("Labeler administration")).toBeTruthy();
		expect(screen.getByText("Reviewer")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Assessments" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Takedowns" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Evaluations" })).toBeNull();
	});
});
