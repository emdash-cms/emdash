import type { CredentialBackupState } from "../types.js";

const FLAGS_OFFSET = 32;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKUP_STATE = 0x10;

/**
 * Read the backup eligibility (BE) and backup state (BS) flags from raw
 * authenticator data. A backup-eligible credential is a synced passkey.
 */
export function readBackupState(authenticatorData: Uint8Array): CredentialBackupState {
	const flags = authenticatorData[FLAGS_OFFSET];
	if (flags === undefined) throw new Error("Authenticator data is too short");
	const eligible = (flags & FLAG_BACKUP_ELIGIBLE) !== 0;
	const backedUp = (flags & FLAG_BACKUP_STATE) !== 0;
	if (backedUp && !eligible) {
		throw new Error("Authenticator reported a backup without backup eligibility");
	}
	return { deviceType: eligible ? "multiDevice" : "singleDevice", backedUp };
}
