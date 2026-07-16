import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client.js";
import { SUBJECT_ALPHA } from "../fixtures/index.js";
import { renderRoute, REVIEWER_IDENTITY } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

const path = `/subjects/${encodeURIComponent(SUBJECT_ALPHA.uri)}`;

describe("SubjectHistory publisher-history section", () => {
	it("renders prior releases and active manual labels from the fixture", async () => {
		vi.spyOn(apiClient, "whoami").mockResolvedValue(REVIEWER_IDENTITY);
		renderRoute(path);
		await screen.findByRole("heading", { name: "Subject history", level: 1 });
		expect(
			await screen.findByRole("heading", { name: "Publisher history", level: 2 }),
		).toBeTruthy();
		expect(screen.getByText(SUBJECT_ALPHA.did)).toBeTruthy();
		expect(screen.getByText("disputed")).toBeTruthy();
		expect(screen.getByText(/3lduzalphaprev1/)).toBeTruthy();
	});

	it("omits the section when the response carries no publisher-history block", async () => {
		vi.spyOn(apiClient, "whoami").mockResolvedValue(REVIEWER_IDENTITY);
		vi.spyOn(apiClient, "getSubjectHistory").mockResolvedValue({
			subject: SUBJECT_ALPHA,
			assessments: [],
		});
		renderRoute(path);
		await screen.findByRole("heading", { name: "Subject history", level: 1 });
		expect(screen.queryByRole("heading", { name: "Publisher history" })).toBeNull();
	});
});
