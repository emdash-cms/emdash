import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchClient, createFixtureClient } from "./client.js";
import type { LabelActionInput } from "./types.js";

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

describe("fetch client label actions", () => {
	const fetchClient = createFetchClient();
	let calls: { url: string; init: RequestInit }[];

	function stubFetch(response: () => Response) {
		calls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init: RequestInit) => {
				calls.push({ url, init });
				return Promise.resolve(response());
			}),
		);
	}

	const input: LabelActionInput = {
		uri: "at://did:plc:x/com.emdashcms.experimental.package.release/rk1",
		val: "security-yanked",
		confirmation: "rk1",
		reason: "withdrawing",
		idempotencyKey: "01HZY9K0ULIDXULIDXULIDX00",
	};

	beforeEach(() => {
		stubFetch(() =>
			Response.json({ data: { actionId: "oact_1", val: "security-yanked", neg: false } }),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs an issue with the CSRF header, JSON content type, and threaded key", async () => {
		const result = await fetchClient.issueLabel(input);
		expect(result).toMatchObject({ actionId: "oact_1", val: "security-yanked" });
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("/admin/api/labels/issue");
		expect(call.init.method).toBe("POST");
		const headers = new Headers(call.init.headers);
		expect(headers.get("X-EmDash-Request")).toBe("1");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(JSON.parse(call.init.body as string)).toMatchObject({
			uri: input.uri,
			val: input.val,
			confirmation: input.confirmation,
			reason: input.reason,
			idempotencyKey: input.idempotencyKey,
		});
	});

	it("POSTs a retract to the retract route", async () => {
		await fetchClient.retractLabel(input);
		expect(calls[0]!.url).toBe("/admin/api/labels/retract");
		expect(calls[0]!.init.method).toBe("POST");
	});

	it("surfaces the server error message on a failed action", async () => {
		stubFetch(() =>
			Response.json(
				{ error: { code: "CONFIRMATION_MISMATCH", message: "does not match" } },
				{
					status: 400,
				},
			),
		);
		await expect(fetchClient.issueLabel(input)).rejects.toThrow("does not match");
	});

	it("builds the effect-preview query string", async () => {
		stubFetch(() =>
			Response.json({ data: { labelEffect: "block", scope: "cid-bound", supersedes: [] } }),
		);
		await fetchClient.previewEffect({ uri: input.uri, val: "malware", cid: "bafy", neg: true });
		const url = calls[0]!.url;
		expect(url).toContain("/admin/api/labels/effect-preview?");
		expect(url).toContain(`uri=${encodeURIComponent(input.uri)}`);
		expect(url).toContain("val=malware");
		expect(url).toContain("cid=bafy");
		expect(url).toContain("neg=true");
	});
});
