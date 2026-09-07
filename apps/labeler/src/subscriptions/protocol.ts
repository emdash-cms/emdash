import { encode, toBytes } from "@atcute/cbor";
import type { SignedListingLabel } from "@emdash-cms/registry-moderation";

export interface LabelSubscriptionEvent {
	sequence: number;
	label: SignedListingLabel;
}

export function encodeLabelEvent(event: LabelSubscriptionEvent): Uint8Array {
	return encodeFrame(
		{ op: 1, t: "#labels" },
		{
			seq: event.sequence,
			labels: [{ ...event.label, sig: toBytes(event.label.sig) }],
		},
	);
}

export function encodeSubscriptionError(error: string, message: string): Uint8Array {
	return encodeFrame({ op: -1 }, { error, message });
}

function encodeFrame(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
): Uint8Array {
	const encodedHeader = encode(header);
	const encodedPayload = encode(payload);
	const frame = new Uint8Array(encodedHeader.length + encodedPayload.length);
	frame.set(encodedHeader);
	frame.set(encodedPayload, encodedHeader.length);
	return frame;
}
