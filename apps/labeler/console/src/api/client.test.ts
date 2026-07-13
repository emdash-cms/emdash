import { describe, expect, it } from "vitest";

import { createFixtureClient } from "./client.js";

const apiClient = createFixtureClient();

describe("fixture client", () => {
	it("lists assessments newest first", async () => {
		const page = await apiClient.listAssessments();
		expect(page.items.length).toBeGreaterThan(0);
		const timestamps = page.items.map((a) => Date.parse(a.createdAt));
		expect(timestamps).toEqual(timestamps.toSorted((a, b) => b - a));
	});

	it("filters assessments by public state", async () => {
		const page = await apiClient.listAssessments({ state: "blocked" });
		expect(page.items.length).toBeGreaterThan(0);
		expect(page.items.every((a) => a.publicState === "blocked")).toBe(true);
	});

	it("returns findings for a blocked assessment", async () => {
		const [blocked] = (await apiClient.listAssessments({ state: "blocked" })).items;
		expect(blocked).toBeDefined();
		const findings = await apiClient.listFindings(blocked!.id);
		expect(findings.length).toBeGreaterThan(0);
		for (const finding of findings) {
			expect(finding.assessmentId).toBe(blocked!.id);
		}
	});

	it("returns null for an unknown assessment id", async () => {
		expect(await apiClient.getAssessment("asmt_does_not_exist")).toBeNull();
	});

	it("returns subject history keyed by the exact URI", async () => {
		const [assessment] = (await apiClient.listAssessments()).items;
		expect(assessment).toBeDefined();
		const history = await apiClient.getSubjectHistory(assessment!.uri);
		expect(history?.subject.uri).toBe(assessment!.uri);
		expect(history?.assessments.some((a) => a.id === assessment!.id)).toBe(true);
	});
});
