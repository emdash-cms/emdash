import { computeMultihash } from "@emdash-cms/registry-verification/checksum";

export interface TarEntryFixture {
	name: string;
	content?: string | Uint8Array;
	type?: string;
	prefix?: string;
}

const encoder = new TextEncoder();
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function createTar(entries: readonly TarEntryFixture[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const body =
			typeof entry.content === "string"
				? encoder.encode(entry.content)
				: (entry.content ?? new Uint8Array());
		blocks.push(tarHeader(entry.name, body.byteLength, entry.type ?? "0", entry.prefix ?? ""));
		const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	return concat(blocks);
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createBundle(entries: readonly TarEntryFixture[]): Promise<Uint8Array> {
	return gzip(createTar(entries));
}

export function cleanBundleEntries(backend = "export default { hooks: {} };\n"): TarEntryFixture[] {
	return [
		{ name: "manifest.json", content: JSON.stringify({ id: "gallery", version: "1.2.3" }) },
		{ name: "backend.js", content: backend },
		{ name: "README.md", content: "# Gallery\n\nBuild galleries.\n" },
	];
}

export async function checksumOf(bytes: Uint8Array): Promise<string> {
	const checksum = await computeMultihash(bytes);
	if (!checksum.success) throw new Error("fixture checksum could not be computed");
	return checksum.value;
}

/** Returns the raw CIDv1 blob reference whose multihash is `checksum`. */
export function blobCidForChecksum(checksum: string): string {
	const multihash = base32Decode(checksum.slice(1));
	return `b${base32Encode(concat([Uint8Array.of(0x01, 0x55), multihash]))}`;
}

function tarHeader(name: string, size: number, type: string, prefix: string): Uint8Array {
	const header = new Uint8Array(512);
	writeString(header, 0, name, 100);
	writeString(header, 100, "0000644\0", 8);
	writeString(header, 108, "0000000\0", 8);
	writeString(header, 116, "0000000\0", 8);
	writeString(header, 124, `${size.toString(8).padStart(11, "0")}\0`, 12);
	writeString(header, 136, "00000000000\0", 12);
	writeString(header, 148, "        ", 8);
	header[156] = type.charCodeAt(0);
	writeString(header, 257, "ustar\0", 6);
	writeString(header, 263, "00", 2);
	writeString(header, 345, prefix, 155);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	writeString(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
	return header;
}

function writeString(target: Uint8Array, offset: number, value: string, length: number): void {
	target.set(encoder.encode(value).subarray(0, length), offset);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return output;
}

function base32Decode(value: string): Uint8Array {
	let bits = 0;
	let buffer = 0;
	const output: number[] = [];
	for (const character of value) {
		buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			output.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Uint8Array.from(output);
}
