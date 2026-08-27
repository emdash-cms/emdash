import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { EmDashPreviewDB } from "../../src/db/playground.js";

interface TestEnv {
	PLAYGROUND_DB: DurableObjectNamespace<EmDashPreviewDB>;
}

const testEnv = env as unknown as TestEnv;
const SUCCESS_PROGRESS = '{"step":"database"}\n{"step":"content"}\n{"step":"ready"}\n';

function getStub(name: string): DurableObjectStub<EmDashPreviewDB> {
	return testEnv.PLAYGROUND_DB.getByName(name);
}

async function readProgress(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

async function readProgressByob(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader({ mode: "byob" });
	const chunks: Uint8Array[] = [];

	for (;;) {
		const { done, value } = await reader.read(new Uint8Array(64));
		if (value?.byteLength) chunks.push(value.slice());
		if (done) break;
	}

	const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

describe("playground Durable Object initialization", () => {
	it("persists readiness until its TTL alarm clears the real SQLite database", async () => {
		const stub = getStub(crypto.randomUUID());

		expect(await stub.isReady()).toBe(false);
		expect(await readProgressByob(await stub.initializePlayground(3600))).toBe(SUCCESS_PROGRESS);
		expect(await stub.isReady()).toBe(true);
		expect(
			await Promise.resolve(
				stub.query("SELECT email FROM users WHERE id = ?", ["playground-admin"]),
			),
		).toEqual({
			rows: [{ email: "playground@emdashcms.com" }],
		});

		expect(await readProgress(await stub.initializePlayground(3600))).toBe(SUCCESS_PROGRESS);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stub.isReady()).toBe(false);
		expect(await readProgress(await stub.initializePlayground(3600))).toBe(SUCCESS_PROGRESS);
		expect(await stub.isReady()).toBe(true);
	});

	it("shares initialization progress with overlapping callers", async () => {
		const stub = getStub(crypto.randomUUID());
		const first = stub.initializePlayground(3600);
		const second = stub.initializePlayground(3600);
		const streams = await Promise.all([first, second]);

		await expect(Promise.all(streams.map(readProgress))).resolves.toEqual([
			SUCCESS_PROGRESS,
			SUCCESS_PROGRESS,
		]);
		expect(await stub.isReady()).toBe(true);
	});
});
