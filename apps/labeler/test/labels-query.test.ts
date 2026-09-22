import { parseSignedListingLabel, verifyListingLabel } from "@emdash-cms/registry-moderation";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { queryLabels } from "../src/labels/query.js";
import { createRuntimeListingLabelSigner } from "../src/runtime-signer.js";
import {
	createTestIssuer,
	decisionContext,
	ISSUER_DID,
	PROFILE_URI,
	PROFILE_SUBJECT,
} from "./issuer-helpers.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("com.atproto.label.queryLabels", () => {
	it("filters retained history and pages by monotonic cursor", async () => {
		const issuer = await createTestIssuer(env.DB);
		const approval = await issuer.approve(decisionContext("query-pass"), PROFILE_SUBJECT);
		const block = await issuer.block(decisionContext("query-block"), PROFILE_SUBJECT);
		const first = approval.labels[0]!;
		const second = block.labels[1]!;

		const firstPage = await queryLabels(
			env.DB,
			new Request(
				`https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${PROFILE_URI.slice(0, -7)}*`)}&sources=${encodeURIComponent(ISSUER_DID)}&limit=1`,
			),
		);
		expect(firstPage.status).toBe(200);
		const firstBody = await firstPage.json<{
			labels: Array<Record<string, unknown>>;
			cursor?: string;
		}>();
		expect(firstBody.cursor).toBe(`${first.sequence}`);
		expect(firstBody.labels).toHaveLength(1);
		expect(firstBody.labels[0]).toEqual(
			expect.objectContaining({
				uri: PROFILE_URI,
				val: "listing-passed",
				sig: { $bytes: expect.any(String) },
			}),
		);

		const secondPage = await queryLabels(
			env.DB,
			new Request(
				`https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(PROFILE_URI)}&cursor=${block.labels[0]!.sequence}&limit=1`,
			),
		);
		const secondBody = await secondPage.json<{ labels: Array<Record<string, unknown>> }>();
		expect(secondBody.labels).toEqual([
			expect.objectContaining({ uri: PROFILE_URI, neg: true, val: "listing-passed" }),
		]);
		expect(second.sequence).toBeGreaterThan(first.sequence);
	});

	it("rejects unbounded or malformed query parameters", async () => {
		for (const url of [
			"https://labeler.test/xrpc/com.atproto.label.queryLabels",
			"https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=at%3A%2F%2Fdid%3Aexample%3Apublisher%2F*%2Fbad",
			"https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=*&sources=not-a-did",
			"https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=*&cursor=-1",
			"https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=*&limit=251",
		]) {
			const response = await queryLabels(env.DB, new Request(url));
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});

	it("re-signs retained history with the current key without rewriting the audit row", async () => {
		const uri = `${PROFILE_URI}-query-key-rotation`;
		const storedSignature = new Uint8Array(64).fill(0x5a);
		await env.DB.prepare(
			`INSERT INTO issued_labels
			 (idempotency_key, actor_did, actor_role, reason, ver, src, uri, cid, val,
			  neg, cts, exp, sig, signing_key_id, publication_pending, created_at)
			 VALUES (?, ?, 'reviewer', 'Retained rotation fixture', 1, ?, ?, ?,
			         'listing-review', 0, ?, NULL, ?, 'old-key', 0, ?)`,
		)
			.bind(
				"query-key-rotation",
				env.LABELER_DID,
				env.LABELER_DID,
				uri,
				PROFILE_SUBJECT.cid,
				"2026-08-24T12:00:00.000Z",
				storedSignature,
				"2026-08-24T12:00:00.000Z",
			)
			.run();

		const response = await queryLabels(
			env.DB,
			new Request(
				`https://labeler.test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
			),
			() => createRuntimeListingLabelSigner(env),
		);
		const body = await response.json<{ labels: Array<Record<string, unknown>> }>();
		const replayed = parseJsonLabel(body.labels[0]);
		await expect(
			verifyListingLabel({
				label: replayed,
				resolveDid: async () => ({
					id: env.LABELER_DID,
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: env.LABELER_DID,
							publicKeyMultibase: env.LABEL_SIGNING_PUBLIC_KEY,
						},
					],
				}),
			}),
		).resolves.toBeDefined();
		expect([...replayed.sig]).not.toEqual([...storedSignature]);
		const stored = await env.DB.prepare(
			"SELECT sig, signing_key_id FROM issued_labels WHERE idempotency_key = ?",
		)
			.bind("query-key-rotation")
			.first<{ sig: ArrayBuffer; signing_key_id: string }>();
		expect([...new Uint8Array(stored!.sig)]).toEqual([...storedSignature]);
		expect(stored?.signing_key_id).toBe("old-key");
	});
});

function parseJsonLabel(value: Record<string, unknown> | undefined) {
	if (!value) throw new TypeError("query did not return a label");
	const encoded = value["sig"];
	if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) {
		throw new TypeError("query label signature is invalid");
	}
	const bytes = Object.getOwnPropertyDescriptor(encoded, "$bytes")?.value;
	if (typeof bytes !== "string") throw new TypeError("query label signature is invalid");
	const { sig: _sig, ...unsigned } = value;
	return parseSignedListingLabel({
		...unsigned,
		sig: Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0)),
	});
}
