import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import {
	createLabelSigner,
	evaluateReleaseModeration,
	verifyLabel,
	PACKAGE_SCOPE_BLOCK_VALUES,
	RELEASE_BLOCK_VALUES,
	type LabelDidDocument,
	type ModerationLabel,
	type VerifiedModerationLabel,
} from "../src/index.js";

const source = "did:example:trusted";
const otherSource = "did:example:other";
const context = {
	publisherDid: "did:example:publisher",
	package: { uri: "at://did:example:publisher/com.example.package/profile", cid: "package-cid" },
	release: { uri: "at://did:example:publisher/com.example.release/1", cid: "release-cid" },
};

function label(
	overrides: Partial<ModerationLabel> & Pick<ModerationLabel, "val">,
): ModerationLabel {
	return {
		ver: 1,
		src: source,
		uri: context.release.uri,
		cid: context.release.cid,
		cts: "2026-07-10T12:00:00.000Z",
		...overrides,
	};
}

let verifiedBrand: symbol;

beforeAll(async () => {
	const resolveDid = async (): Promise<LabelDidDocument> => ({
		id: source,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: source,
				publicKeyMultibase: "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ",
			},
		],
	});
	const signer = await createLabelSigner({
		issuerDid: source,
		privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
		resolveDid,
	});
	const verifiedLabel = await verifyLabel({
		label: await signer.sign({
			ver: 1,
			uri: context.release.uri,
			cid: "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m",
			val: "assessment-passed",
			cts: "2026-07-10T12:00:00.000Z",
		}),
		resolveDid,
	});
	const brand = Reflect.ownKeys(verifiedLabel).find(
		(key): key is symbol => typeof key === "symbol",
	);
	if (!brand) throw new Error("verified label is missing its runtime brand");
	verifiedBrand = brand;
});

// Evaluator policy tests use a brand recovered from a real verified label.
function verified(rawLabel: ModerationLabel): VerifiedModerationLabel {
	Object.defineProperty(rawLabel, verifiedBrand, { value: true });
	return rawLabel as unknown as VerifiedModerationLabel;
}

function evaluate(labels: ModerationLabel[], redact = false) {
	return evaluateReleaseModeration({
		acceptedLabelers: [{ did: source, redact }],
		context,
		evaluatedAt: "2026-07-10T13:00:00.000Z",
		labels: labels.map(verified),
	});
}

describe("release moderation", () => {
	it("rejects a raw label forged with a TypeScript cast", () => {
		expect(() =>
			evaluateReleaseModeration({
				acceptedLabelers: [{ did: source, redact: false }],
				context,
				evaluatedAt: "2026-07-10T13:00:00.000Z",
				labels: [label({ val: "assessment-passed" }) as unknown as VerifiedModerationLabel],
			}),
		).toThrow("must be verified");
	});

	it("accepts an exact-CID assessment pass", () => {
		expect(evaluate([label({ val: "assessment-passed" })])).toMatchObject({
			eligibility: "eligible",
			reasonCodes: ["eligible-assessment-pass"],
		});
	});

	it("blocks when no accepted source has a pass", () => {
		expect(evaluate([])).toMatchObject({
			eligibility: "blocked",
			reasonCodes: ["missing-assessment-pass"],
		});
	});

	it("uses a current negation rather than an older pass", () => {
		const pass = label({ val: "assessment-passed" });
		const negation = label({
			val: "assessment-passed",
			neg: true,
			cts: "2026-07-10T12:01:00.000Z",
		});
		expect(evaluate([pass, negation]).eligibility).toBe("blocked");
	});

	it("does not revive an older pass when the current winner expires", () => {
		const pass = label({ val: "assessment-passed" });
		const expired = label({
			val: "assessment-passed",
			cts: "2026-07-10T12:01:00.000Z",
			exp: "2026-07-10T12:30:00.000Z",
		});
		expect(evaluate([pass, expired]).eligibility).toBe("blocked");
	});

	it("fails closed on non-identical equal-time stream events", () => {
		const pass = label({ val: "assessment-passed" });
		const collision = label({ val: "assessment-passed", cid: "different-cid" });
		expect(evaluate([pass, collision])).toMatchObject({
			eligibility: "error",
			reasonCodes: ["label-state-collision"],
		});
	});

	it("does not let a collision for unrelated CIDs block the current release", () => {
		const first = label({ val: "assessment-passed", cid: "old-release-cid" });
		const second = label({ val: "assessment-passed", cid: "another-old-release-cid" });
		expect(evaluate([first, second])).toMatchObject({
			eligibility: "blocked",
			reasonCodes: ["missing-assessment-pass"],
		});
	});

	it("does not apply a release label for another CID", () => {
		expect(
			evaluate([label({ val: "assessment-passed", cid: "old-release-cid" })]).eligibility,
		).toBe("blocked");
	});

	it("cascades URI-wide package and publisher actions", () => {
		const packageTakedown = label({ val: "!takedown", uri: context.package.uri, cid: undefined });
		const publisherBlock = label({
			val: "publisher-compromised",
			uri: context.publisherDid,
			cid: undefined,
		});
		expect(evaluate([label({ val: "assessment-passed" }), packageTakedown]).eligibility).toBe(
			"blocked",
		);
		expect(evaluate([label({ val: "assessment-passed" }), publisherBlock]).eligibility).toBe(
			"blocked",
		);
	});

	it("does not apply CID-bound manual actions to a different revision", () => {
		const releaseTakedown = label({ val: "!takedown", cid: "old-release-cid" });
		const packageYank = label({
			val: "!takedown",
			uri: context.package.uri,
			cid: "old-package-cid",
		});
		expect(evaluate([label({ val: "assessment-passed" }), releaseTakedown]).eligibility).toBe(
			"eligible",
		);
		expect(evaluate([label({ val: "assessment-passed" }), packageYank]).eligibility).toBe(
			"eligible",
		);
	});

	it("keeps warning-only releases eligible", () => {
		expect(
			evaluate([label({ val: "assessment-passed" }), label({ val: "suspicious-code" })]),
		).toMatchObject({
			eligibility: "eligible",
			warningLabels: ["suspicious-code"],
		});
	});

	it("suppresses only its source's automated findings with a valid override", () => {
		const result = evaluate([
			label({ val: "assessment-passed" }),
			label({ val: "assessment-overridden" }),
			label({ val: "assessment-pending" }),
			label({ val: "malware" }),
		]);
		expect(result).toMatchObject({
			eligibility: "eligible",
			suppressedLabels: ["assessment-pending", "malware"],
		});
	});

	it("does not let an override bypass a broader manual block", () => {
		const publisherBlock = label({
			val: "publisher-compromised",
			uri: context.publisherDid,
			cid: undefined,
		});
		expect(
			evaluate([
				label({ val: "assessment-passed" }),
				label({ val: "assessment-overridden" }),
				publisherBlock,
			]),
		).toMatchObject({
			eligibility: "blocked",
			reasonCodes: ["manual-block"],
		});
	});

	it("aggregates another accepted source's error, pending, and block over a pass", () => {
		const acceptedLabelers = [
			{ did: source, redact: false },
			{ did: otherSource, redact: false },
		];
		for (const value of ["assessment-error", "assessment-pending", "malware"] as const) {
			const result = evaluateReleaseModeration({
				acceptedLabelers,
				context,
				evaluatedAt: "2026-07-10T13:00:00.000Z",
				labels: [label({ val: "assessment-passed" }), label({ val: value, src: otherSource })].map(
					verified,
				),
			});
			expect(result.eligibility).toBe(
				value === "assessment-error"
					? "error"
					: value === "assessment-pending"
						? "pending"
						: "blocked",
			);
		}
	});

	it("ignores an unaccepted source", () => {
		const result = evaluate([label({ val: "assessment-passed", src: otherSource })]);
		expect(result).toMatchObject({
			eligibility: "blocked",
			reasonCodes: ["missing-assessment-pass", "unaccepted-labels-ignored"],
		});
	});

	it("does not parse malformed labels from unaccepted sources", () => {
		const result = evaluate([
			label({ val: "assessment-passed" }),
			label({ val: "malware", src: otherSource, cts: "not-a-datetime" }),
		]);
		expect(result).toMatchObject({
			eligibility: "eligible",
			reasonCodes: ["eligible-assessment-pass", "unaccepted-labels-ignored"],
		});
	});

	it("ignores unknown label values, including a colliding stream", () => {
		const unknown = label({ val: "future-label" });
		const collision = label({ val: "future-label", cid: "other-cid" });
		expect(evaluate([label({ val: "assessment-passed" }), unknown, collision])).toMatchObject({
			eligibility: "eligible",
			reasonCodes: ["eligible-assessment-pass"],
		});
	});

	it("always blocks accepted takedowns while redact controls only presentation", () => {
		const takedown = label({ val: "!takedown", cid: undefined });
		expect(evaluate([label({ val: "assessment-passed" }), takedown], false)).toMatchObject({
			eligibility: "blocked",
			redacted: false,
		});
		expect(evaluate([label({ val: "assessment-passed" }), takedown], true)).toMatchObject({
			eligibility: "blocked",
			redacted: true,
		});
	});

	it("ORs redact flags for duplicate accepted labeler policies", () => {
		const result = evaluateReleaseModeration({
			acceptedLabelers: [
				{ did: source, redact: false },
				{ did: source, redact: true },
			],
			context,
			evaluatedAt: "2026-07-10T13:00:00.000Z",
			labels: [label({ val: "!takedown", cid: undefined })].map(verified),
		});
		expect(result).toMatchObject({ eligibility: "blocked", redacted: true });
	});

	it("treats explicit false negation as an omitted negation", () => {
		const pass = label({ val: "assessment-passed" });
		const currentPass = label({
			val: "assessment-passed",
			cid: "release-cid",
			neg: false,
		});
		expect(evaluate([pass, currentPass]).eligibility).toBe("eligible");
	});

	it("orders arbitrary fractional timestamps without truncating milliseconds", () => {
		const oldPass = label({ val: "assessment-passed", cts: "2026-07-10T12:00:00.1234Z" });
		const pending = label({
			val: "assessment-passed",
			neg: true,
			cts: "2026-07-10T12:00:00.1235Z",
		});
		expect(evaluate([oldPass, pending]).eligibility).toBe("blocked");
	});

	it("rejects invalid RFC 3339 calendar and timestamp syntax", () => {
		expect(() =>
			evaluate([label({ val: "assessment-passed", cts: "2026-02-30T12:00:00Z" })]),
		).toThrow(TypeError);
		expect(() =>
			evaluate([label({ val: "assessment-passed", cts: "2026-07-10 12:00:00Z" })]),
		).toThrow(TypeError);
		expect(() =>
			evaluate([label({ val: "assessment-passed", cts: "2026-07-10T12:00:00-00:00" })]),
		).toThrow(TypeError);
		expect(() =>
			evaluate([label({ val: "assessment-passed", cts: "0000-01-01T00:00:00Z" })]),
		).toThrow(TypeError);
		expect(() =>
			evaluate([label({ val: "assessment-passed", cts: "0000-01-01T00:00:00+01:00" })]),
		).toThrow(TypeError);
	});
});

describe("exported hard-block value sets", () => {
	it("blocks every RELEASE_BLOCK_VALUES value on the exact release", () => {
		for (const value of RELEASE_BLOCK_VALUES) {
			const result = evaluate([label({ val: "assessment-passed" }), label({ val: value })]);
			expect(result.eligibility, `${value} should block the release`).toBe("blocked");
		}
	});

	it("blocks every PACKAGE_SCOPE_BLOCK_VALUES value on the publisher DID", () => {
		for (const value of PACKAGE_SCOPE_BLOCK_VALUES) {
			const publisherLabel = label({ val: value, uri: context.publisherDid, cid: undefined });
			const result = evaluate([label({ val: "assessment-passed" }), publisherLabel]);
			expect(result.eligibility, `${value} should block via the publisher DID`).toBe("blocked");
		}
	});

	it("blocks a package-URI !takedown", () => {
		const packageTakedown = label({ val: "!takedown", uri: context.package.uri, cid: undefined });
		const result = evaluate([label({ val: "assessment-passed" }), packageTakedown]);
		expect(result.eligibility).toBe("blocked");
	});
});

interface FixtureLabel {
	src: string;
	subject: "release" | "package" | "publisher";
	cid?: string;
	val: string;
	cts: string;
	neg?: boolean;
	exp?: string;
}

interface FixtureCase {
	id: string;
	acceptedLabellers?: { src: string; redact: boolean }[];
	subject?: Record<string, string>;
	labels?: FixtureLabel[];
	expected: {
		eligibility: string;
		reasonCodes: string[];
		blockingLabels: string[];
		stateLabels: string[];
		warningLabels: string[];
		suppressedLabels: string[];
		redacted: boolean;
	};
}

const corpus = JSON.parse(
	readFileSync(new URL("./fixtures/moderation-cases.json", import.meta.url), "utf8"),
) as {
	evaluatedAt: string;
	sources: Record<string, string>;
	caseDefaults: Required<Pick<FixtureCase, "acceptedLabellers" | "subject" | "labels">>;
	cases: FixtureCase[];
};

function expectedValues(references: string[]): string[] {
	return references.map((reference) => reference.slice(reference.lastIndexOf(":") + 1)).toSorted();
}

describe("ratified moderation corpus", () => {
	for (const fixtureCase of corpus.cases) {
		it(fixtureCase.id, () => {
			const subject = { ...corpus.caseDefaults.subject, ...fixtureCase.subject };
			const labels = fixtureCase.labels ?? corpus.caseDefaults.labels;
			const result = evaluateReleaseModeration({
				acceptedLabelers: (
					fixtureCase.acceptedLabellers ?? corpus.caseDefaults.acceptedLabellers
				).map((policy) => ({
					did: corpus.sources[policy.src]!,
					redact: policy.redact,
				})),
				context: {
					publisherDid: subject.publisherDid!,
					package: { uri: subject.packageUri!, cid: subject.packageCid! },
					release: { uri: subject.releaseUri!, cid: subject.releaseCid! },
				},
				evaluatedAt: corpus.evaluatedAt,
				labels: labels.map((fixtureLabel) =>
					verified({
						ver: 1,
						src: corpus.sources[fixtureLabel.src]!,
						uri:
							fixtureLabel.subject === "publisher"
								? subject.publisherDid!
								: fixtureLabel.subject === "package"
									? subject.packageUri!
									: subject.releaseUri!,
						cid: fixtureLabel.cid,
						val: fixtureLabel.val,
						cts: fixtureLabel.cts,
						neg: fixtureLabel.neg,
						exp: fixtureLabel.exp,
					}),
				),
			});
			expect(result).toMatchObject({
				eligibility: fixtureCase.expected.eligibility,
				reasonCodes: fixtureCase.expected.reasonCodes,
				blockingLabels: expectedValues(fixtureCase.expected.blockingLabels),
				stateLabels: expectedValues(fixtureCase.expected.stateLabels),
				warningLabels: expectedValues(fixtureCase.expected.warningLabels),
				suppressedLabels: expectedValues(fixtureCase.expected.suppressedLabels),
				redacted: fixtureCase.expected.redacted,
			});
		});
	}
});
