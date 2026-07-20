import { fromBase64Url, toBase64Url } from "@atcute/multibase";
import type { SignedLabel } from "@emdash-cms/registry-moderation";

/** A `SignedLabel` with `sig` as an unpadded base64url string for queue serialization. */
export interface SignedLabelWire extends Omit<SignedLabel, "sig"> {
	sig: string;
}

/**
 * One label queued for durable history + projection writes. Enqueued only
 * after `label-ingestor.ts` verifies the signature; `sourceSequence` and
 * `frameIndex` pin the label's coordinates in the source labeler's stream for
 * the `(src, source_sequence, frame_index)` collision check.
 */
export interface LabelIngestJob {
	src: string;
	sourceSequence: number;
	frameIndex: number;
	label: SignedLabelWire;
}

export function toWire(label: SignedLabel): SignedLabelWire {
	const { sig, ...rest } = label;
	return { ...rest, sig: toBase64Url(sig) };
}

export function fromWire(wire: SignedLabelWire): SignedLabel {
	const { sig, ...rest } = wire;
	return { ...rest, sig: fromBase64Url(sig) };
}
