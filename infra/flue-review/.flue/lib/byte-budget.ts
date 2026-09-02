export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	let end = Math.min(bytes.byteLength, maxBytes);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}

export function limitUtf8Text(value: string, maxBytes: number, suffix: string): string {
	if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("maxBytes must be a positive integer");
	}
	if (utf8ByteLength(value) <= maxBytes) return value;

	const boundedSuffix = utf8Prefix(suffix, maxBytes);
	const prefixBytes = Math.max(0, maxBytes - utf8ByteLength(boundedSuffix));
	return utf8Prefix(value, prefixBytes) + boundedSuffix;
}
