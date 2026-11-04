import { afterEach, describe, expect, it, vi } from "vitest";

import { assessmentAction, type AssessmentListItem } from "../../src/admin/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("operator admin API client", () => {
	it("adds the same-origin mutation proof and a fresh idempotency key", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ action: "approve" }));
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("crypto", { randomUUID: () => "request-12345678" });
		const assessment: AssessmentListItem = {
			run_key: "run-1",
			subject_uri: "at://did:plc:test/profile/example",
			subject_cid: "bafytest",
			subject_kind: "profile",
			state: "review",
			assessment_state: "review",
			state_version: 1,
			policy_version: "v1",
			created_at: "2026-08-27T10:00:00.000Z",
			updated_at: "2026-08-27T10:00:00.000Z",
			completed_at: null,
		};

		await assessmentAction(assessment, "approve", "Reviewed exact metadata");

		expect(fetchMock).toHaveBeenCalledWith(
			"/_admin/api/assessments/run-1/approve",
			expect.objectContaining({
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-EmDash-Request": "1",
					"Idempotency-Key": "request-12345678",
				},
			}),
		);
		expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
			reason: "Reviewed exact metadata",
			uri: assessment.subject_uri,
			cid: assessment.subject_cid,
		});
	});

	it("preserves structured API errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{ error: { code: "SUBJECT_CHANGED", message: "Subject changed" } },
					{ status: 409 },
				),
			),
		);
		vi.stubGlobal("crypto", { randomUUID: () => "request-12345678" });

		await expect(
			assessmentAction(
				{
					run_key: "run-1",
					subject_uri: "at://did:plc:test/profile/example",
					subject_cid: "bafytest",
					subject_kind: "profile",
					state: "review",
					assessment_state: "review",
					state_version: 1,
					policy_version: "v1",
					created_at: "2026-08-27T10:00:00.000Z",
					updated_at: "2026-08-27T10:00:00.000Z",
					completed_at: null,
				},
				"approve",
				"Reviewed exact metadata",
			),
		).rejects.toMatchObject({ code: "SUBJECT_CHANGED", status: 409 });
	});
});
