import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { issueManualLabel, type AllowedLabelProposal } from "../src/service.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:example:labeler";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const config = { labelerDid: LABELER_DID };
let actionNumber = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function releaseUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

function profileUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/${name}`;
}

function action(reason: string) {
	actionNumber++;
	return {
		actor: "did:example:moderator",
		type: "manual-label" as const,
		reason,
		idempotencyKey: `test-${actionNumber}`,
	};
}

function proposal(uri: string, val: AllowedLabelProposal["val"] = "security-yanked") {
	return { uri, val };
}

function document(did = LABELER_DID): LabelDidDocument {
	return {
		id: did,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: did,
				publicKeyMultibase: MULTIKEY,
			},
		],
	};
}

async function signer() {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

async function foreignSigner() {
	const issuerDid = "did:example:foreign";
	return createLabelSigner({
		issuerDid,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(issuerDid),
	});
}

async function issue(uri: string, val?: AllowedLabelProposal["val"], neg = false) {
	return issueManualLabel(
		testEnv.DB,
		config,
		await signer(),
		action(`test issue ${actionNumber + 1}`),
		{
			...proposal(uri, val),
			...(neg ? { neg: true } : {}),
		},
	);
}

describe("manual label issuance", () => {
	it("issues a signed label that the public query returns without a secret", async () => {
		const uri = releaseUri("round-trip");
		const issued = await issue(uri);

		const response = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			labels: Array<{
				sig: { $bytes: string };
				src: string;
				uri: string;
				val: string;
				cts: string;
			}>;
		};
		expect(body.labels).toHaveLength(1);
		expect(body.labels[0]).toMatchObject({ src: LABELER_DID, uri, val: "security-yanked" });

		const returned = body.labels[0]!;
		await expect(
			verifyLabel({
				label: { ...returned, ver: 1, sig: fromBase64(returned.sig.$bytes) },
				resolveDid: async () => document(),
			}),
		).resolves.toMatchObject({ src: LABELER_DID, uri, val: "security-yanked" });
		expect(issued.signingKeyId).toBe(`${LABELER_DID}#atproto_label`);
	});

	it("allocates monotonically increasing sequences", async () => {
		const first = await issue(releaseUri("sequence-a"));
		const second = await issue(releaseUri("sequence-b"));
		expect(second.sequence).toBeGreaterThan(first.sequence);
	});

	it("returns the original signed label for a duplicate action", async () => {
		const labelSigner = await signer();
		const originalAction = action("idempotent issue");
		const input = proposal(releaseUri("idempotent"));
		const first = await issueManualLabel(testEnv.DB, config, labelSigner, originalAction, input);
		const second = await issueManualLabel(testEnv.DB, config, labelSigner, originalAction, input);
		expect(second.sequence).toBe(first.sequence);
		expect(second.label).toEqual(first.label);
		const count = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS count FROM issued_labels l
				 JOIN issuance_actions a ON a.id = l.action_id
				 WHERE a.idempotency_key = ?`,
		)
			.bind(originalAction.idempotencyKey)
			.first<{ count: number }>();
		expect(count?.count).toBe(1);
	});

	it("records a later negation as a new signed history entry", async () => {
		const uri = releaseUri("negation");
		const active = await issue(uri, "security-yanked");
		const negated = await issue(uri, "security-yanked", true);
		expect(negated.sequence).toBeGreaterThan(active.sequence);

		const response = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
		);
		const body = (await response.json()) as { labels: Array<{ neg?: boolean }> };
		expect(body.labels).toHaveLength(2);
		expect(body.labels.map((label) => label.neg === true)).toEqual([false, true]);
	});

	it("enforces the manual proposal subject table", async () => {
		await expect(issue(PUBLISHER_DID, "!takedown")).resolves.toBeDefined();
		await expect(issue(profileUri("disputed"), "package-disputed")).resolves.toBeDefined();
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("CID takedown"), {
				uri: releaseUri("exact-cid"),
				cid: CID,
				val: "!takedown",
			}),
		).rejects.toThrow("!takedown must not include a CID");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("CID security yank"), {
				uri: releaseUri("yanked-cid"),
				cid: CID,
				val: "security-yanked",
			}),
		).rejects.toThrow("security-yanked must not include a CID");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid disputed release"), {
				uri: releaseUri("not-disputed"),
				val: "package-disputed",
			}),
		).rejects.toThrow("package profile");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid yanked package"), {
				uri: profileUri("not-yanked"),
				val: "security-yanked",
			}),
		).rejects.toThrow("release record");
	});

	it("rejects a signer that is not bound to the configured labeler DID", async () => {
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				await foreignSigner(),
				action("foreign signer"),
				proposal(releaseUri("foreign-signer")),
			),
		).rejects.toThrow("configured labeler DID");
	});

	it("allows only signature metadata rotation after sequence allocation", async () => {
		const issued = await issue(releaseUri("key-rotation"));
		await expect(
			testEnv.DB.prepare("UPDATE issued_labels SET sig = ?, signing_key_id = ? WHERE sequence = ?")
				.bind(issued.label.sig, "did:example:labeler#rotated", issued.sequence)
				.run(),
		).resolves.toBeDefined();
		await expect(
			testEnv.DB.prepare("UPDATE issued_labels SET val = ? WHERE sequence = ?")
				.bind("package-disputed", issued.sequence)
				.run(),
		).rejects.toThrow("issued labels are immutable");
	});

	it("filters URI prefixes and sources, then paginates in sequence order", async () => {
		const base = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/paging-`;
		await issue(`${base}a:1.0.0`);
		await issue(`${base}b:1.0.0`);
		await issue(`${base}c:1.0.0`);
		const first = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=${LABELER_DID}&limit=2`,
		);
		const firstBody = (await first.json()) as { labels: Array<{ uri: string }>; cursor: string };
		expect(firstBody.labels).toHaveLength(2);
		expect(firstBody.cursor).toBeTruthy();
		const second = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=${LABELER_DID}&limit=2&cursor=${firstBody.cursor}`,
		);
		const secondBody = (await second.json()) as { labels: Array<{ uri: string }>; cursor?: string };
		expect(secondBody.labels).toHaveLength(1);
		expect(secondBody.cursor).toBeUndefined();
		const wrongSource = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=did:example:other`,
		);
		expect(((await wrongSource.json()) as { labels: unknown[] }).labels).toEqual([]);
	});

	it("rejects invalid issuance and query input", async () => {
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid subject"), {
				uri: "https://example.com/not-a-subject",
				val: "security-yanked",
			}),
		).rejects.toThrow("security-yanked must target a release record");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid publisher CID"), {
				uri: PUBLISHER_DID,
				cid: CID,
				val: "publisher-compromised",
			}),
		).rejects.toThrow("publisher-compromised");
		const missingPatterns = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?limit=2",
		);
		expect(missingPatterns.status).toBe(400);
		const badCursor = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=at%3A%2F%2Fdid%3Aexample%3Aone%2F*&cursor=0",
		);
		expect(badCursor.status).toBe(400);
		const methodNotAllowed = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=did%3Aexample%3Atest",
			{ method: "POST" },
		);
		expect(methodNotAllowed.status).toBe(405);
		expect(methodNotAllowed.headers.get("allow")).toBe("GET");
		expect(await methodNotAllowed.json()).toMatchObject({ error: "MethodNotSupported" });
		const unknown = await SELF.fetch("https://test/xrpc/com.example.unknown");
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: "MethodNotSupported" });
	});
});

function fromBase64(value: string): Uint8Array {
	const decoded = atob(value);
	return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
