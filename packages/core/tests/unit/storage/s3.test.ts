import { afterEach, describe, expect, it, vi } from "vitest";

// The AWS SDK is a "bring-your-own" dependency of emdash core — it is NOT
// installed in CI. Stub it here so loading s3.ts (which statically imports
// both modules) does not require the real package.
vi.mock("@aws-sdk/client-s3", () => {
	class S3Client {
		send(_command: unknown): Promise<unknown> {
			return Promise.resolve({});
		}
	}
	class Command {
		constructor(public input: unknown) {}
	}
	return {
		S3Client,
		PutObjectCommand: Command,
		GetObjectCommand: Command,
		DeleteObjectCommand: Command,
		HeadObjectCommand: Command,
		ListObjectsV2Command: Command,
	};
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
	getSignedUrl: () => Promise.resolve("https://signed.example.com/fake"),
}));

import { createStorage, resolveS3Config } from "../../../src/storage/s3.js";
import { EmDashStorageError } from "../../../src/storage/types.js";

const FULL_ENV = {
	S3_ENDPOINT: "https://bucket.s3.example.com",
	S3_BUCKET: "my-bucket",
	S3_ACCESS_KEY_ID: "env-key",
	S3_SECRET_ACCESS_KEY: "env-secret",
	S3_REGION: "us-east-1",
	S3_PUBLIC_URL: "https://cdn.example.com",
};

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) vi.stubEnv(key, "");
		else vi.stubEnv(key, value);
	}
}

function runWithoutProcess(fn: () => void): void {
	const saved = globalThis.process;
	try {
		// @ts-expect-error -- simulating Workers environment for test
		delete globalThis.process;
		fn();
	} finally {
		globalThis.process = saved;
	}
}

function catchError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
}

describe("resolveS3Config", () => {
	afterEach(() => vi.unstubAllEnvs());

	describe("precedence", () => {
		it.each([
			["endpoint", "S3_ENDPOINT", "https://explicit.example.com", "https://env.example.com"],
			["bucket", "S3_BUCKET", "explicit-bucket", "env-bucket"],
			["region", "S3_REGION", "us-east-1", "eu-west-1"],
			["publicUrl", "S3_PUBLIC_URL", "https://explicit.cdn", "https://env.cdn"],
		] as const)("explicit %s wins over %s env var", (field, envKey, explicitValue, envValue) => {
			setEnv({ ...FULL_ENV, [envKey]: envValue });
			const cfg = resolveS3Config({ [field]: explicitValue });
			expect(cfg[field]).toBe(explicitValue);
		});

		it("explicit credentials win over env credentials", () => {
			setEnv(FULL_ENV);
			const r = resolveS3Config({
				accessKeyId: "explicit-key",
				secretAccessKey: "explicit-secret",
			});
			expect(r.accessKeyId).toBe("explicit-key");
			expect(r.secretAccessKey).toBe("explicit-secret");
		});

		it("env fills in missing fields from partial explicit config", () => {
			setEnv(FULL_ENV);
			const r = resolveS3Config({ region: "ap-southeast-1" });
			expect(r.endpoint).toBe(FULL_ENV.S3_ENDPOINT);
			expect(r.bucket).toBe(FULL_ENV.S3_BUCKET);
			expect(r.region).toBe("ap-southeast-1");
		});

		it("s3() with full env resolves entirely from env", () => {
			setEnv(FULL_ENV);
			const r = resolveS3Config({});
			expect(r.endpoint).toBe(FULL_ENV.S3_ENDPOINT);
			expect(r.bucket).toBe(FULL_ENV.S3_BUCKET);
			expect(r.accessKeyId).toBe(FULL_ENV.S3_ACCESS_KEY_ID);
			expect(r.secretAccessKey).toBe(FULL_ENV.S3_SECRET_ACCESS_KEY);
			expect(r.region).toBe(FULL_ENV.S3_REGION);
			expect(r.publicUrl).toBe(FULL_ENV.S3_PUBLIC_URL);
		});
	});

	describe("empty string coercion", () => {
		it("s3({ endpoint: '' }) falls through to env", () => {
			setEnv(FULL_ENV);
			expect(resolveS3Config({ endpoint: "" }).endpoint).toBe(FULL_ENV.S3_ENDPOINT);
		});

		it("S3_ENDPOINT='' with explicit endpoint: explicit wins", () => {
			setEnv({ ...FULL_ENV, S3_ENDPOINT: "" });
			expect(resolveS3Config({ endpoint: "https://explicit.example.com" }).endpoint).toBe(
				"https://explicit.example.com",
			);
		});

		it("both empty: throws missing-field error", () => {
			setEnv({ S3_ENDPOINT: "", S3_BUCKET: FULL_ENV.S3_BUCKET });
			expect(() => resolveS3Config({ endpoint: "" })).toThrow(EmDashStorageError);
		});
	});

	describe("required fields", () => {
		it.each([
			[
				"endpoint",
				"S3_ENDPOINT",
				{ S3_BUCKET: FULL_ENV.S3_BUCKET, S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" },
			],
			[
				"bucket",
				"S3_BUCKET",
				{ S3_ENDPOINT: FULL_ENV.S3_ENDPOINT, S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" },
			],
		] as const)("missing %s throws with %s in the message", (_field, envKey, env) => {
			setEnv(env);
			expect(() => resolveS3Config({})).toThrow(envKey);
		});

		it("missing both: one error lists both fields", () => {
			setEnv({
				S3_ENDPOINT: undefined,
				S3_BUCKET: undefined,
				S3_ACCESS_KEY_ID: undefined,
				S3_SECRET_ACCESS_KEY: undefined,
				S3_REGION: undefined,
				S3_PUBLIC_URL: undefined,
			});
			const err = catchError(() => resolveS3Config({}));
			expect(err).toBeInstanceOf(EmDashStorageError);
			const msg = (err as Error).message;
			expect(msg).toContain("S3_ENDPOINT");
			expect(msg).toContain("S3_BUCKET");
		});
	});

	describe("endpoint URL validation", () => {
		it("accepts https:// URLs", () => {
			setEnv({ ...FULL_ENV, S3_ENDPOINT: "https://x.example.com" });
			expect(resolveS3Config({}).endpoint).toBe("https://x.example.com");
		});

		it("accepts http://localhost for dev (MinIO)", () => {
			setEnv({ ...FULL_ENV, S3_ENDPOINT: "http://localhost:9000" });
			expect(resolveS3Config({}).endpoint).toBe("http://localhost:9000");
		});

		it.each(["ftp://x.example.com", "not-a-url", "https://"])(
			"rejects invalid env endpoint %s: names S3_ENDPOINT as source",
			(invalidUrl) => {
				setEnv({ ...FULL_ENV, S3_ENDPOINT: invalidUrl });
				expect(() => resolveS3Config({})).toThrow("S3_ENDPOINT");
			},
		);

		it("rejects non-URL from explicit: names s3({ endpoint }) as source", () => {
			setEnv(FULL_ENV);
			expect(() => resolveS3Config({ endpoint: "not-a-url" })).toThrow("s3({ endpoint })");
		});

		it("malformed S3_ENDPOINT is ignored when explicit endpoint is provided", () => {
			setEnv({ ...FULL_ENV, S3_ENDPOINT: "not-a-url" });
			const r = resolveS3Config({ endpoint: "https://explicit.example.com" });
			expect(r.endpoint).toBe("https://explicit.example.com");
		});
	});

	describe("credential pairing", () => {
		it("neither credential provided: resolves without them", () => {
			setEnv({ S3_ENDPOINT: FULL_ENV.S3_ENDPOINT, S3_BUCKET: FULL_ENV.S3_BUCKET });
			const r = resolveS3Config({});
			expect(r.accessKeyId).toBeUndefined();
			expect(r.secretAccessKey).toBeUndefined();
		});

		it("only accessKeyId provided: error names the missing secretAccessKey", () => {
			setEnv({ ...FULL_ENV, S3_SECRET_ACCESS_KEY: undefined });
			const err = catchError(() => resolveS3Config({ accessKeyId: "only-key" }));
			expect(err).toBeInstanceOf(EmDashStorageError);
			const msg = (err as Error).message;
			expect(msg).toContain("secretAccessKey");
			expect(msg).toContain("S3_SECRET_ACCESS_KEY");
		});

		it("only secretAccessKey provided: error names the missing accessKeyId", () => {
			setEnv({ ...FULL_ENV, S3_ACCESS_KEY_ID: undefined });
			const err = catchError(() => resolveS3Config({ secretAccessKey: "only-secret" }));
			expect(err).toBeInstanceOf(EmDashStorageError);
			const msg = (err as Error).message;
			expect(msg).toContain("accessKeyId");
			expect(msg).toContain("S3_ACCESS_KEY_ID");
		});
	});

	describe("Workers guard (typeof process === 'undefined')", () => {
		it("process undefined with explicit config: resolveS3Config succeeds", () => {
			runWithoutProcess(() => {
				const r = resolveS3Config({
					endpoint: "https://x.example.com",
					bucket: "b",
					accessKeyId: "k",
					secretAccessKey: "s",
				});
				expect(r.endpoint).toBe("https://x.example.com");
			});
		});

		it("process undefined, no explicit config: throws missing-field error", () => {
			runWithoutProcess(() => {
				expect(() => resolveS3Config({})).toThrow(EmDashStorageError);
			});
		});
	});

	describe("round-trip", () => {
		it("createStorage({}) with full S3_* env returns a storage instance", () => {
			setEnv(FULL_ENV);
			const storage = createStorage({});
			expect(typeof storage.upload).toBe("function");
			expect(typeof storage.getPublicUrl).toBe("function");
		});
	});
});
