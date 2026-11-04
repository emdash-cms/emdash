import type { TransparencyLogEntry } from "@sigstore/bundle";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import type { TLogAuthority } from "@sigstore/verify";
import { verifyCheckpoint } from "@sigstore/verify/dist/tlog/checkpoint.js";
import { describe, expect, it } from "vitest";

import reusableBundleFixture from "../fixtures/provenance/analytics-0.3.1-slsa.bundle.json";
import actionsBundleFixture from "../fixtures/provenance/linguadash-0.2.0-slsa.bundle.json";
import bundleFixture from "../fixtures/provenance/sigstore-core-4.0.1-slsa.bundle.json";
import { computeMultihash, GitHubProvenanceVerifier } from "../src/index.js";
import { provenanceTestInternals } from "../src/provenance.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const artifactDigest = decodeHex(
	"f6fe61463ba39f9357abca3b5c511480bc80b5daf9222b1be29cccd39bb72bad484b9ab784fde5b96027764d1190f3cb4d41684db83b55bf38510d5941e6a359",
);
const sourceRepository = "https://github.com/sigstore/sigstore-js";
const builderId =
	"https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main";
const predicateType = "https://slsa.dev/provenance/v1";
const repositoryId = "495574555";
const workflowRef = "refs/heads/main";
const commitSha = "d406ea60b342ca37cdeecd7afedb992cd189db92";
const invocationId = "https://github.com/sigstore/sigstore-js/actions/runs/28204693054/attempts/1";

const actionsRelease = {
	artifactDigest: decodeHex("7f72922dadfe3764e90a6dd2b462a55d6e7db539a7acd17ea332436fcfd87d9a"),
	sourceRepository: "https://github.com/swissky/emdash-plugin-linguadash",
	builderId:
		"https://github.com/swissky/emdash-plugin-linguadash/.github/workflows/emdash-release.yml@refs/tags/linguadash@0.2.0",
	repositoryId: "1387495587",
	workflowRef: "refs/tags/linguadash@0.2.0",
	commitSha: "e97be0a6353d8038f76b4fc1002ee77d26f0b3fa",
	invocationId:
		"https://github.com/swissky/emdash-plugin-linguadash/actions/runs/37491967820/attempts/1",
	url: "https://github.com/swissky/emdash-plugin-linguadash/attestations/53240928",
} as const;

const reusableRelease = {
	artifactDigest: decodeHex("4669ca928249741972855f09d2f17bf265e40b02d4982b561da74b46d80f9560"),
	sourceRepository: "https://github.com/eisbachcode/emdash-plugin-analytics",
	builderId:
		"https://github.com/eisbachcode/emdash-plugin-analytics/.github/workflows/release.yml@refs/heads/main",
	repositoryId: "1384219962",
	workflowRef: "refs/heads/main",
	commitSha: "c0d3df3a788c8b5bd489d9cfb9c5c62bcf212ad3",
	invocationId:
		"https://github.com/eisbachcode/emdash-plugin-analytics/actions/runs/37486660259/attempts/1",
	url: "https://github.com/eisbachcode/emdash-plugin-analytics/attestations/53226901",
} as const;
const reusableSignerId =
	"https://github.com/eisbachcode/emdash-plugin-analytics/.github/workflows/emdash-release.yml@refs/heads/main";

const algorithmVectors = [
	{
		name: "P-256 DSSE and Rekor SET",
		publicKey:
			"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaR9S4pCcthbA6Wn4xE6l7QWvsHZ8\nrlTJdRNUfTXZI0NQhLxEO+xu7nvx8AbdMZwB/tgE+nQDlihGULqaH41uKg==\n-----END PUBLIC KEY-----\n",
		signature:
			"MEUCIQCT7gKkdVKUso50JKlPnNXAzaLCfAfqrMEROImh/07JcwIgf0a2WyUWfDUXuKMkypX4LIcJccjTlaaCn2P0wjws41c=",
	},
	{
		name: "P-384",
		publicKey:
			"-----BEGIN PUBLIC KEY-----\nMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEVY4tPR0XC5w8RzdsUXihLEk+G9buag+E\npQzu18CT6Z/h+dXCwARAQ2WTYm9/lvRJ1cDEU7/iJYnGbEAxOL71aLMDO9aChRxr\nGJHBNkEaRQJXZBfAOwKbIWcT4qNa3KCK\n-----END PUBLIC KEY-----\n",
		signature:
			"MGYCMQCt19J0Sk849EJCBDz9pp5/WrEvv3ctdBEgZxqUX6qWA9Tbs8KqMb36fQ2ivavN2TgCMQCsEdtmgDk2xbw0QKusQOLuEe2qygOjUg3gNmUYNl5Ff7+sZZzMzIzHTWRzjR0OApE=",
	},
	{
		name: "P-521",
		publicKey:
			"-----BEGIN PUBLIC KEY-----\nMIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQAZaAP050ZJWaG/VPG6OZYyqjHEwTo\n9zWNlKJN5SWdkZ1V0xRsA/gZ3wkWlopuLqhkq8XdYg+8xRkzHv7LUObsHLoAB+GJ\n0ICOgeIzTGxuxLKSLeFgon3ZS5fogW2kH9Fw4tOkFWbjKr1KrNKgXpIKHw6p+aFw\nJSsauROC/ObfFcaaADw=\n-----END PUBLIC KEY-----\n",
		signature:
			"MIGIAkIAk3w/mjUAG4CoUGgSoyhnJOmpVaKjVbzfVl+7MpqQd0yOBmgBWsx6jlPRBLnFJCI4QPNMniM8H3BtDuM1OKf6tYMCQgFOgfr3fls3dgxYrbuaZ0rAvj6CR0UDcDhIf1shQZzOZXoy7GJxooOuAkr/EKNr7KRXKnPh/uAFTT+CoRASGb8wbA==",
	},
	{
		name: "Ed25519 checkpoint",
		publicKey:
			"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqxa7LJtwfaKrveTZrXxQCqmOtKk0LbRqenSNyqzdy30=\n-----END PUBLIC KEY-----\n",
		signature:
			"pyTySg8eOsb/IGiUbJfMrCUcL3i1/NOuOSEoDR5Nd/fRXIWE1fEP7exliZXWLak4Lx2Ukec/u5KdTvgcsblOAg==",
	},
] as const;
const unsupportedRsaVector = {
	publicKey:
		"-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0faCSJXV48bMihPd44jq\n1mvYTphLf2k04RXNPn777/sF50HddbbXjW4bT3zSawx232ohILxnAZ4BL39QLB67\n86/PfP7kKaMtKsxWDavUc5eIrLlLTWJIqG8zJEcY1/Cb3jHgupunRdyA8ju3LZ3W\n+KiAkJhTgKJZ7Ze3Yj+wl5VOiHD9uv5sA9DLVMqhQ5tfDntRyeVxJNpU3JDQFBX1\nMa6Dh8IUfVLXnGRt+y+IvsAjD3MVzwHuRgE6UGCmvXgZxJmNQRst8Bo+4GH5ilU5\nUUiqGunG42s/OR0DFtuSvwcCDHxuCE5ynPXY1+WVFTv7DYufDjdA16uo8wDzR8MV\n2QIDAQAB\n-----END PUBLIC KEY-----\n",
	signature:
		"rvbTsc/ZR5BfCU6L4do/7rqyrdbXRjuw1XJRBkqqg9tB7h2thcwH55pxiOexqOiw+8ng/sEnn+0L6eycXDpIUqTVl+4ZAMOQCxUduwiU8pdgyddxig2++5zilqMMK3C95c2E9Bh6+nNvFo5dbEqAY8+TIs/mCQR0EZJVjrBjSMWBlDWuSBsyna03NfGq5crI57l4/DKqn9NccbSit6mt+B72X57DRPC5pHmJ5qyBKjHPxQMzBuoCHmgvyXJ2zB9qumap+Z4h3p2c2oK7uIXkTgBLDr5KZp6Z2kLCRv/trgkFTxFsx9uSgUOK+up6GN+T3bOKFhlm2z1AtFxxM3SxYQ==",
} as const;
const ed25519Checkpoint = {
	publicKey:
		"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAITobQsIt45oxsOpPAePZrZZQ//881SN3vfdJ7Od7fVU=\n-----END PUBLIC KEY-----\n",
	logId: "5KlPCSRCu7a+d4+UHIX7+Kc8jducDUnjqe3BJ70j1N0=",
	envelope:
		"ed25519.example\n42\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\n— ed25519.example 5KlPCQhhuoZe7IjLHVcPymostUlwREMmssMQLkDxW816g948TgdfgkgzeN98btzfuXGPVXHGMdCkBvumO/VdXx7gyQ4=\n",
} as const;

export function provenanceContract(): void {
	describe("GitHub Sigstore SLSA v1 provenance", () => {
		it("verifies the reviewed public Sigstore bundle all-or-nothing", async () => {
			const document = fixtureDocument();
			const result = await verify(document);

			expect(result).toEqual({
				success: true,
				value: {
					artifactDigest,
					builderId,
					commitSha,
					invocationId,
					predicateType,
					repositoryId,
					sourceRepository,
					workflowRef,
				},
			});
		});

		it("verifies a bundle that uses the actions.github.io build type", async () => {
			const document = encoder.encode(JSON.stringify(actionsBundleFixture));
			const checksum = await computeMultihash(document);
			if (!checksum.success) throw new Error("Test fixture checksum could not be computed");
			const { url, ...expected } = actionsRelease;
			const result = await new GitHubProvenanceVerifier().verify({
				document,
				reference: {
					builderId: actionsRelease.builderId,
					checksum: checksum.value,
					predicateType,
					sourceRepository: actionsRelease.sourceRepository,
					url,
				},
				artifactDigest: actionsRelease.artifactDigest,
				profileRepository: actionsRelease.sourceRepository,
			});

			expect(result).toEqual({ success: true, value: { ...expected, predicateType } });
		});

		it("verifies a same-repository reusable workflow and returns the caller identity", async () => {
			const { url, ...expected } = reusableRelease;
			const result = await verify(
				encoder.encode(JSON.stringify(reusableBundleFixture)),
				{
					builderId: reusableRelease.builderId,
					sourceRepository: reusableRelease.sourceRepository,
					url,
				},
				reusableRelease.artifactDigest,
				reusableRelease.sourceRepository,
			);

			expect(result).toEqual({ success: true, value: { ...expected, predicateType } });
		});

		it("matches one of the caller's bounded artifact digest candidates", async () => {
			const document = fixtureDocument();
			const checksum = await computeMultihash(document);
			if (!checksum.success) throw new Error("Test fixture checksum could not be computed");
			const result = await new GitHubProvenanceVerifier().verify({
				document,
				reference: {
					builderId,
					checksum: checksum.value,
					predicateType,
					sourceRepository,
					url: "https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2fcore@4.0.1",
				},
				artifactDigest: new Uint8Array(32),
				artifactDigests: [artifactDigest],
				profileRepository: sourceRepository,
			});

			expect(result).toMatchObject({ success: true, value: { artifactDigest } });
		});

		it("snapshots mutable inputs before checksum verification yields", async () => {
			const document = fixtureDocument();
			const digest = new Uint8Array(artifactDigest);
			const checksum = await computeMultihash(document);
			if (!checksum.success) throw new Error("Test fixture checksum could not be computed");
			const reference = {
				builderId,
				checksum: checksum.value,
				predicateType,
				sourceRepository,
				url: "https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2fcore@4.0.1",
			};
			const resultPromise = new GitHubProvenanceVerifier().verify({
				document,
				reference,
				artifactDigest: digest,
				profileRepository: sourceRepository,
			});

			document.fill(0);
			digest.fill(0);
			reference.builderId = "https://example.test/substituted";

			expect(await resultPromise).toMatchObject({
				success: true,
				value: { builderId, artifactDigest },
			});
		});

		it("rejects checksum substitution before bundle verification", async () => {
			const result = await verify(fixtureDocument(), {
				checksum: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
			});
			expectUnverifiable(result);
		});

		it("rejects a bad DSSE signature", async () => {
			const document = mutatedDocument((bundle) => {
				const signature = bundle.dsseEnvelope.signatures[0];
				if (signature) signature.sig = replaceBase64Byte(signature.sig);
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects a tampered signed payload", async () => {
			const document = mutatedStatement((statement) => {
				statement.subject[0].name = "pkg:npm/substituted@1.0.0";
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects an artifact digest absent from every subject", async () => {
			expectUnverifiable(await verify(fixtureDocument(), {}, new Uint8Array(64)));
		});

		it.each([
			[
				"release reference",
				{ sourceRepository: "https://github.com/example/other" },
				sourceRepository,
			],
			["signed profile", {}, "https://github.com/example/other"],
		])("rejects a repository mismatch in the %s", async (_name, reference, profile) => {
			expectUnverifiable(await verify(fixtureDocument(), reference, artifactDigest, profile));
		});

		it("rejects an attested repository mismatch", async () => {
			const document = mutatedStatement((statement) => {
				statement.predicate.buildDefinition.externalParameters.workflow.repository =
					"https://github.com/example/other";
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects a workflow builder mismatch", async () => {
			expectUnverifiable(
				await verify(fixtureDocument(), {
					builderId:
						"https://github.com/sigstore/sigstore-js/.github/workflows/other.yml@refs/heads/main",
				}),
			);
		});

		it("rejects an attested workflow mismatch", async () => {
			const document = mutatedStatement((statement) => {
				statement.predicate.buildDefinition.externalParameters.workflow.path =
					".github/workflows/other.yml";
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects an unknown predicate", async () => {
			const document = mutatedStatement((statement) => {
				statement.predicateType = "https://example.test/provenance/v2";
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects an unsupported bundle format", async () => {
			const document = mutatedDocument((bundle) => {
				bundle.mediaType = "application/vnd.dev.sigstore.bundle.v0.4+json";
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects untrusted certificate material", async () => {
			const document = mutatedDocument((bundle) => {
				bundle.verificationMaterial.certificate.rawBytes = replaceLastBase64Byte(
					bundle.verificationMaterial.certificate.rawBytes,
				);
			});
			expectUnverifiable(await verify(document));
		});

		it("rejects a certificate outside its validity period", async () => {
			const document = mutatedDocument((bundle) => {
				bundle.verificationMaterial.tlogEntries[0].integratedTime = "1893456000";
			});
			expectUnverifiable(await verify(document));
		});
	});

	describe("GitHub-hosted runner policy", () => {
		it("accepts both build type formats from GitHub-hosted runners", () => {
			expect(() => validateFixtureStatement(bundleFixture)).not.toThrow();
			expect(() => validateFixtureStatement(actionsBundleFixture)).not.toThrow();
		});

		it.each<[string, (statement: RunnerStatement) => void]>([
			[
				"a self-hosted runner environment",
				(statement) => {
					statement.predicate.buildDefinition.internalParameters.github.runner_environment =
						"self-hosted";
				},
			],
			[
				"no runner environment",
				(statement) => {
					delete statement.predicate.buildDefinition.internalParameters.github.runner_environment;
				},
			],
			[
				"the legacy runner builder ID",
				(statement) => {
					statement.predicate.runDetails.builder.id =
						"https://github.com/actions/runner/github-hosted";
				},
			],
		])("rejects an actions.github.io statement with %s", (_name, mutate) => {
			expect(() => validateFixtureStatement(actionsBundleFixture, mutate)).toThrow(
				"Unsupported GitHub Actions runner class",
			);
		});

		it("rejects a legacy statement whose builder ID names the workflow", () => {
			expect(() =>
				validateFixtureStatement(bundleFixture, (statement) => {
					statement.predicate.runDetails.builder.id = builderId;
				}),
			).toThrow("Unsupported GitHub Actions runner class");
		});

		it("rejects an unknown build type", () => {
			expect(() =>
				validateFixtureStatement(actionsBundleFixture, (statement) => {
					statement.predicate.buildDefinition.buildType = "https://example.test/buildtypes/v1";
				}),
			).toThrow("Unsupported SLSA build type");
		});

		it("rejects a certificate issued to a self-hosted runner", () => {
			const expected = {
				artifactDigest,
				repository: sourceRepository,
				builderId,
				signerId: builderId,
				workflowRef,
				commitSha,
				repositoryId,
				invocationId,
			};
			const identity = (runnerEnvironment: string) => ({
				subjectAlternativeName: builderId,
				extensions: { issuer: "https://token.actions.githubusercontent.com" },
				oids: Object.entries({
					8: "https://token.actions.githubusercontent.com",
					9: builderId,
					10: commitSha,
					11: runnerEnvironment,
					12: sourceRepository,
					13: commitSha,
					14: workflowRef,
					15: repositoryId,
					18: builderId,
					19: commitSha,
					21: invocationId,
				}).map(([suffix, value]) => ({
					oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, Number(suffix)] },
					value: Buffer.from(derUtf8(value)),
				})),
			});

			expect(() =>
				provenanceTestInternals.validateSignerIdentity(identity("github-hosted"), expected),
			).not.toThrow();
			expect(() =>
				provenanceTestInternals.validateSignerIdentity(identity("self-hosted"), expected),
			).toThrow("Certificate and predicate identity mismatch");
		});
	});

	describe("Same-repository reusable workflow identity", () => {
		it.each([
			"https://github.com/example/other/.github/workflows/emdash-release.yml@refs/heads/main",
			"https://github.com/eisbachcode/emdash-plugin-analytics/.github/workflows/emdash-release.yml@refs/heads/other",
			"https://github.com/eisbachcode/emdash-plugin-analytics/emdash-release.yml@refs/heads/main",
		])("rejects an unsupported signing workflow %s", (signerId) => {
			expect(() =>
				validateFixtureStatement(reusableBundleFixture, (statement) => {
					statement.predicate.runDetails.builder.id = signerId;
				}),
			).toThrow("Unsupported GitHub Actions runner class");
		});

		it("authenticates the signer separately from the calling workflow", () => {
			const expected = validateFixtureStatement(reusableBundleFixture);
			expect(() =>
				provenanceTestInternals.validateSignerIdentity(reusableCertificateIdentity(), expected),
			).not.toThrow();
		});

		it.each([
			[9, reusableRelease.builderId],
			[18, reusableSignerId],
			[10, "a".repeat(40)],
			[19, "a".repeat(40)],
		])("rejects a substituted certificate workflow identity in OID %s", (suffix, value) => {
			const expected = validateFixtureStatement(reusableBundleFixture);
			expect(() =>
				provenanceTestInternals.validateSignerIdentity(
					reusableCertificateIdentity({ [suffix]: value }),
					expected,
				),
			).toThrow("Certificate and predicate identity mismatch");
		});

		it("rejects a certificate SAN naming the caller instead of the signer", () => {
			const identity = reusableCertificateIdentity();
			identity.subjectAlternativeName = reusableRelease.builderId;
			expect(() =>
				provenanceTestInternals.validateSignerIdentity(
					identity,
					validateFixtureStatement(reusableBundleFixture),
				),
			).toThrow("Certificate identity mismatch");
		});
	});

	describe("@sigstore/core omitted verification algorithm mapping", () => {
		it.each(algorithmVectors)("verifies $name fail-closed from KeyObject details", (vector) => {
			const key = sigstoreCrypto.createPublicKey(vector.publicKey);
			expect(
				sigstoreCrypto.verify(
					Buffer.from("sigstore algorithm mapping regression"),
					key,
					Buffer.from(vector.signature, "base64"),
				),
			).toBe(true);
		});

		it("rejects an unsupported RSA key when the algorithm is omitted", () => {
			const key = sigstoreCrypto.createPublicKey(unsupportedRsaVector.publicKey);
			expect(
				sigstoreCrypto.verify(
					Buffer.from("sigstore algorithm mapping regression"),
					key,
					Buffer.from(unsupportedRsaVector.signature, "base64"),
				),
			).toBe(false);
		});

		it("verifies an Ed25519 signed-checkpoint path with an omitted algorithm", () => {
			const logId = Buffer.from(ed25519Checkpoint.logId, "base64");
			const tlog: TLogAuthority = {
				logID: logId,
				baseURL: "https://ed25519.example",
				publicKey: sigstoreCrypto.createPublicKey(ed25519Checkpoint.publicKey),
				validFor: { start: new Date(0), end: new Date("9999-12-31T23:59:59Z") },
			};
			const entry = {
				inclusionProof: { checkpoint: { envelope: ed25519Checkpoint.envelope } },
			} as unknown as TransparencyLogEntry;

			expect(verifyCheckpoint(entry, [tlog])).toMatchObject({
				origin: "ed25519.example",
				logSize: 42n,
			});
		});
	});

	describe("Fulcio identity DER decoding", () => {
		it("decodes one canonical UTF8String value", () => {
			expect(provenanceTestInternals.decodeDerUtf8String(derUtf8("refs/heads/main"))).toBe(
				"refs/heads/main",
			);
		});

		it.each([
			Uint8Array.of(0x16, 1, 0x61),
			Uint8Array.of(0x0c, 0x80),
			Uint8Array.of(0x0c, 0x81, 1, 0x61),
			Uint8Array.of(0x0c, 2, 0x61),
			Uint8Array.of(0x0c, 1, 0xff),
		])("rejects malformed or non-canonical DER %#", (value) => {
			expect(() => provenanceTestInternals.decodeDerUtf8String(value)).toThrow();
		});

		it("rejects missing and duplicate authoritative OIDs", () => {
			const oid = {
				oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 18] },
				value: Buffer.from(derUtf8(builderId)),
			};
			expect(() => provenanceTestInternals.readRequiredOid([], 18)).toThrow();
			expect(() => provenanceTestInternals.readRequiredOid([oid, oid], 18)).toThrow();
		});
	});

	describe("Sigstore SAN policy", () => {
		it.each([
			"https://github.com/example/repo/.github/workflows/release.yml@refs/heads/release+1",
			"https://github.com/example/repo/.github/workflows/release.yml@refs/heads/release.*",
			"https://github.com/example/repo/.github/workflows/release.yml@refs/heads/release[1",
		])("constructs an anchored literal policy for %s", (identity) => {
			const pattern = provenanceTestInternals.exactRegexPattern(identity);
			const expression = new RegExp(pattern);

			expect(expression.test(identity)).toBe(true);
			expect(expression.test(`${identity}-substituted`)).toBe(false);
			expect(expression.test(identity.replace("example", "attacker"))).toBe(false);
		});
	});
}

type FixtureBundle = typeof bundleFixture;
type FixtureStatement = {
	_type: string;
	subject: { name: string; digest: Record<string, string> }[];
	predicateType: string;
	predicate: {
		buildDefinition: {
			externalParameters: {
				workflow: { repository: string; path: string; ref: string };
			};
		};
	};
};

type RunnerStatement = {
	_type: string;
	subject: unknown[];
	predicateType: string;
	predicate: {
		buildDefinition: {
			buildType: string;
			externalParameters: { workflow: { repository: string; path: string; ref: string } };
			internalParameters: { github: { runner_environment?: string } };
		};
		runDetails: { builder: { id: string } };
	};
};

function validateFixtureStatement(
	bundle: { dsseEnvelope: { payload: string } },
	mutate: (statement: RunnerStatement) => void = () => {},
) {
	const statement: RunnerStatement = JSON.parse(
		decoder.decode(decodeBase64(bundle.dsseEnvelope.payload)),
	);
	mutate(statement);
	const { workflow } = statement.predicate.buildDefinition.externalParameters;
	const { repository } = workflow;
	return provenanceTestInternals.validateStatement(statement, {
		document: new Uint8Array(),
		reference: {
			builderId: `${repository}/${workflow.path}@${workflow.ref}`,
			checksum: "",
			predicateType,
			sourceRepository: repository,
			url: "https://example.test/attestation",
		},
		artifactDigest,
		artifactDigests: [actionsRelease.artifactDigest, reusableRelease.artifactDigest],
		profileRepository: repository,
	});
}

function reusableCertificateIdentity(overrides: Record<number, string> = {}) {
	return {
		subjectAlternativeName: reusableSignerId,
		extensions: { issuer: "https://token.actions.githubusercontent.com" },
		oids: Object.entries({
			8: "https://token.actions.githubusercontent.com",
			9: reusableSignerId,
			10: reusableRelease.commitSha,
			11: "github-hosted",
			12: reusableRelease.sourceRepository,
			13: reusableRelease.commitSha,
			14: reusableRelease.workflowRef,
			15: reusableRelease.repositoryId,
			18: reusableRelease.builderId,
			19: reusableRelease.commitSha,
			21: reusableRelease.invocationId,
			...overrides,
		}).map(([suffix, value]) => ({
			oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, Number(suffix)] },
			value: Buffer.from(derUtf8(value)),
		})),
	};
}

function fixtureDocument(): Uint8Array {
	return encoder.encode(JSON.stringify(bundleFixture));
}

function mutatedDocument(mutate: (bundle: FixtureBundle) => void): Uint8Array {
	const bundle = structuredClone(bundleFixture);
	mutate(bundle);
	return encoder.encode(JSON.stringify(bundle));
}

function mutatedStatement(mutate: (statement: FixtureStatement) => void): Uint8Array {
	return mutatedDocument((bundle) => {
		const statement = JSON.parse(decoder.decode(decodeBase64(bundle.dsseEnvelope.payload)));
		mutate(statement);
		bundle.dsseEnvelope.payload = encodeBase64(encoder.encode(JSON.stringify(statement)));
	});
}

async function verify(
	document: Uint8Array,
	referenceOverrides: Partial<{
		builderId: string;
		checksum: string;
		predicateType: string;
		sourceRepository: string;
		url: string;
	}> = {},
	digest = artifactDigest,
	profileRepository = sourceRepository,
) {
	const checksum = await computeMultihash(document);
	if (!checksum.success) throw new Error("Test fixture checksum could not be computed");
	return new GitHubProvenanceVerifier().verify({
		document,
		reference: {
			builderId,
			checksum: checksum.value,
			predicateType,
			sourceRepository,
			url: "https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2fcore@4.0.1",
			...referenceOverrides,
		},
		artifactDigest: digest,
		profileRepository,
	});
}

function expectUnverifiable(result: Awaited<ReturnType<typeof verify>>): void {
	expect(result).toEqual({
		success: false,
		error: {
			code: "PROVENANCE_UNVERIFIABLE",
			message: "The supplied provenance could not be verified.",
		},
	});
}

function decodeHex(value: string): Uint8Array {
	if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) throw new Error("Invalid hex fixture");
	return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}

function replaceBase64Byte(value: string): string {
	const bytes = decodeBase64(value);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	return encodeBase64(bytes);
}

function replaceLastBase64Byte(value: string): string {
	const bytes = decodeBase64(value);
	const index = bytes.length - 1;
	bytes[index] = (bytes[index] ?? 0) ^ 1;
	return encodeBase64(bytes);
}

function derUtf8(value: string): Uint8Array {
	const bytes = encoder.encode(value);
	if (bytes.byteLength >= 0x80) throw new Error("Test DER helper only supports short values");
	return Uint8Array.of(0x0c, bytes.byteLength, ...bytes);
}
