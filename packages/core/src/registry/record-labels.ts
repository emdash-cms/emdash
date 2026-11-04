interface VersionedRecordLabel {
	val?: string;
	uri?: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

export function hasCurrentRecordLabel(
	labels: readonly VersionedRecordLabel[],
	value: string,
	record: { uri: string; cid: string },
	now = Date.now(),
): boolean {
	return labels.some((label) => {
		if (
			label.val !== value ||
			label.uri !== record.uri ||
			label.cid !== record.cid ||
			label.neg === true
		) {
			return false;
		}
		if (label.exp === undefined) return true;
		const expiresAt = Date.parse(label.exp);
		return Number.isFinite(expiresAt) && expiresAt > now;
	});
}
