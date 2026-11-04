import type { EncryptionContext } from "../crypto/encryption.js";

export const MAX_ENCRYPTION_RECORD_PAGE = 100;

export interface EncryptionRecord {
	cursor: string;
	envelope: string;
	keyVersion: number;
	context: EncryptionContext;
}

export interface EncryptionRecordPage {
	items: readonly EncryptionRecord[];
	nextCursor: string | null;
}

export interface EncryptionRecordReplacement {
	cursor: string;
	expectedEnvelope: string;
	replacementEnvelope: string;
	replacementKeyVersion: number;
	actorIdentity: string;
	now?: number;
}
