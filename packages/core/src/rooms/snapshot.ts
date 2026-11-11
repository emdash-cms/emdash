import { decodeBase64, encodeBase64 } from "@oslojs/encoding";
import * as Y from "yjs";

/** The record's form of a snapshot: base64 of `Y.encodeSnapshot`. */
export function encodeCheckpoint(snapshot: Y.Snapshot): string {
	return encodeBase64(Y.encodeSnapshot(snapshot));
}

export function decodeCheckpoint(checkpoint: string): Y.Snapshot {
	return Y.decodeSnapshot(decodeBase64(checkpoint));
}
