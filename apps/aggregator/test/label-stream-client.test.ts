/**
 * `decodeLabelStreamFrame` unit tests.
 *
 * Frames are built the same way `apps/labeler/src/subscribe-labels.ts`'s
 * `encodeEvent` builds them: two CBOR-encoded values (header, payload)
 * concatenated with no length prefix. Testing the decode function directly
 * (rather than driving a real WebSocket) mirrors `jetstream-client.ts`'s
 * `wrapAtcuteSubscription` test seam — the transport plumbing around it is
 * exercised by the ingestor/DO integration paths, not here.
 */

import { encode, toBytes } from "@atcute/cbor";
import { describe, expect, it } from "vitest";

import { decodeLabelStreamFrame, LabelStreamError } from "../src/label-stream-client.js";

function frame(header: Record<string, unknown>, payload: Record<string, unknown>): Uint8Array {
	const encodedHeader = encode(header);
	const encodedPayload = encode(payload);
	const bytes = new Uint8Array(encodedHeader.length + encodedPayload.length);
	bytes.set(encodedHeader);
	bytes.set(encodedPayload, encodedHeader.length);
	return bytes;
}

function sampleLabel(uri: string): Record<string, unknown> {
	return {
		ver: 1,
		src: "did:web:labeler.example",
		uri,
		val: "test-value",
		cts: "2026-07-10T12:00:00.000Z",
		sig: toBytes(new Uint8Array(64).fill(7)),
	};
}

describe("decodeLabelStreamFrame", () => {
	it("decodes a valid #labels frame", () => {
		const bytes = frame(
			{ op: 1, t: "#labels" },
			{ seq: 1, labels: [sampleLabel("at://did:example:pub/x/1")] },
		);
		const event = decodeLabelStreamFrame(bytes);
		expect(event).not.toBeNull();
		expect(event?.seq).toBe(1);
		expect(event?.labels).toHaveLength(1);
	});

	it("decodes a multi-label frame", () => {
		const bytes = frame(
			{ op: 1, t: "#labels" },
			{
				seq: 42,
				labels: [sampleLabel("at://did:example:pub/a/1"), sampleLabel("at://did:example:pub/b/1")],
			},
		);
		const event = decodeLabelStreamFrame(bytes);
		expect(event?.seq).toBe(42);
		expect(event?.labels).toHaveLength(2);
	});

	it("ignores an op:1 frame with an unrecognised t (forward compatibility)", () => {
		const bytes = frame({ op: 1, t: "#futureEventKind" }, { anything: true });
		expect(decodeLabelStreamFrame(bytes)).toBeNull();
	});

	it("throws LabelStreamError carrying error and message for an op:-1 frame", () => {
		const bytes = frame(
			{ op: -1 },
			{ error: "FutureCursor", message: "cursor is ahead of the stream" },
		);
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(LabelStreamError);
		try {
			decodeLabelStreamFrame(bytes);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(LabelStreamError);
			const streamErr = err as LabelStreamError;
			expect(streamErr.error).toBe("FutureCursor");
			expect(streamErr.message).toBe("cursor is ahead of the stream");
		}
	});

	it("throws on an op:-1 frame missing error/message fields", () => {
		const bytes = frame({ op: -1 }, { unrelated: true });
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("throws on an unsupported op", () => {
		const bytes = frame({ op: 2 }, { seq: 1, labels: [sampleLabel("at://did:example:pub/x/1")] });
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("throws on malformed CBOR", () => {
		const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
		expect(() => decodeLabelStreamFrame(garbage)).toThrow(TypeError);
	});

	it("throws when the header isn't a CBOR object", () => {
		const encodedHeader = encode("not-an-object");
		const encodedPayload = encode({ seq: 1, labels: [sampleLabel("at://did:example:pub/x/1")] });
		const bytes = new Uint8Array(encodedHeader.length + encodedPayload.length);
		bytes.set(encodedHeader);
		bytes.set(encodedPayload, encodedHeader.length);
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("rejects a non-positive seq", () => {
		const bytes = frame(
			{ op: 1, t: "#labels" },
			{ seq: 0, labels: [sampleLabel("at://did:example:pub/x/1")] },
		);
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("rejects a non-integer seq", () => {
		const bytes = frame(
			{ op: 1, t: "#labels" },
			{ seq: 1.5, labels: [sampleLabel("at://did:example:pub/x/1")] },
		);
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("rejects an empty labels array", () => {
		const bytes = frame({ op: 1, t: "#labels" }, { seq: 1, labels: [] });
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("rejects a labels array over the 200-entry cap", () => {
		const labels = Array.from({ length: 201 }, (_, i) =>
			sampleLabel(`at://did:example:pub/x/${i}`),
		);
		const bytes = frame({ op: 1, t: "#labels" }, { seq: 1, labels });
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(TypeError);
	});

	it("accepts exactly 200 labels", () => {
		const labels = Array.from({ length: 200 }, (_, i) =>
			sampleLabel(`at://did:example:pub/x/${i}`),
		);
		const bytes = frame({ op: 1, t: "#labels" }, { seq: 1, labels });
		const event = decodeLabelStreamFrame(bytes);
		expect(event?.labels).toHaveLength(200);
	});
});
