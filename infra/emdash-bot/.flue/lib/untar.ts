// Streaming untar for GitHub source tarballs (post-gunzip). The parser is the
// trust boundary between an externally-supplied archive and the review
// workspace: entry paths and symlink targets are validated so no write can
// land outside the destination directory.

/** The subset of the Workspace surface the untar needs; narrow for testing. */
export interface UntarTarget {
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	symlink(target: string, linkPath: string): Promise<void>;
	writeFileBytes(path: string, content: Uint8Array): Promise<void>;
}

/** Ceiling on a single entry's declared size; content is buffered in DO memory. */
const MAX_ENTRY_SIZE = 64 * 1024 * 1024;

const OCTAL_FIELD = /^[0-7]*$/;

function stripRoot(name: string): string | undefined {
	const slash = name.indexOf("/");
	if (slash === -1) return undefined;
	const rest = name.slice(slash + 1);
	return rest.length > 0 ? rest : undefined;
}

function parentOf(path: string): string {
	return path.slice(0, path.lastIndexOf("/"));
}

function normalizeSegments(path: string): string[] | undefined {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return undefined;
			out.pop();
			continue;
		}
		out.push(part);
	}
	return out;
}

/**
 * Untar a ustar stream into `destDir`, stripping the archive's single
 * top-level directory. Handles regular files, directories, symlinks, GNU
 * longname/longlink ('L'/'K') and pax ('x') path/linkpath overrides. One
 * entry's content is buffered at a time, capped at MAX_ENTRY_SIZE. Rejects
 * any entry path or symlink target that would resolve outside `destDir`.
 */
export async function untarInto(
	target: UntarTarget,
	stream: ReadableStream<Uint8Array>,
	destDir: string,
): Promise<{ files: number; bytes: number }> {
	const decoder = new TextDecoder();
	let buffer = new Uint8Array(0);
	let files = 0;
	let bytes = 0;
	let pendingLongName: string | undefined;
	let pendingLongLink: string | undefined;
	let pendingPaxPath: string | undefined;
	let pendingPaxLink: string | undefined;
	const dirsMade = new Set<string>();

	const append = (chunk: Uint8Array) => {
		const next = new Uint8Array(buffer.length + chunk.length);
		next.set(buffer, 0);
		next.set(chunk, buffer.length);
		buffer = next;
	};
	const readCString = (view: Uint8Array): string => {
		const end = view.indexOf(0);
		return decoder.decode(end === -1 ? view : view.subarray(0, end));
	};
	const ensureDir = async (path: string) => {
		if (dirsMade.has(path)) return;
		await target.mkdir(path, { recursive: true });
		dirsMade.add(path);
	};

	const reader = stream.getReader();
	let done = false;
	const need = async (n: number): Promise<boolean> => {
		while (buffer.length < n && !done) {
			const r = await reader.read();
			if (r.done) done = true;
			else append(r.value);
		}
		return buffer.length >= n;
	};

	while (await need(512)) {
		const header = buffer.subarray(0, 512);
		buffer = buffer.subarray(512);
		// Two consecutive zero blocks terminate the archive.
		if (header.every((b) => b === 0)) break;

		const rawName = readCString(header.subarray(0, 100));
		const prefix = readCString(header.subarray(345, 500));
		const sizeField = readCString(header.subarray(124, 136)).trim();
		if (!OCTAL_FIELD.test(sizeField)) {
			throw new Error(`tar entry size is not octal ("${sizeField}"): ${rawName}`);
		}
		const size = sizeField ? parseInt(sizeField, 8) : 0;
		// Mode bytes (100-108) are ignored: the workspace has no chmod and the
		// reviewer never executes files.
		const type = String.fromCharCode(header[156] ?? 48);

		if (size > MAX_ENTRY_SIZE) {
			throw new Error(`tar entry size out of range (${size} bytes): ${rawName}`);
		}
		const padded = Math.ceil(size / 512) * 512;
		if (!(await need(padded)) && size > 0) {
			throw new Error(`tar truncated: needed ${padded} bytes for entry ${rawName}`);
		}
		const content = buffer.subarray(0, size);
		buffer = buffer.subarray(Math.min(padded, buffer.length));

		if (type === "L") {
			pendingLongName = readCString(content);
			continue;
		}
		if (type === "K") {
			pendingLongLink = readCString(content);
			continue;
		}
		if (type === "x" || type === "g") {
			// pax records: "<len> key=value\n"
			const text = decoder.decode(content);
			for (const line of text.split("\n")) {
				const eq = line.indexOf("=");
				if (eq <= 0) continue;
				const key = line.slice(line.indexOf(" ") + 1, eq);
				if (key === "path") pendingPaxPath = line.slice(eq + 1);
				else if (key === "linkpath") pendingPaxLink = line.slice(eq + 1);
			}
			continue;
		}

		const fullName =
			pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
		const linkTarget = pendingPaxLink ?? pendingLongLink ?? readCString(header.subarray(157, 257));
		pendingLongName = undefined;
		pendingLongLink = undefined;
		pendingPaxPath = undefined;
		pendingPaxLink = undefined;

		if (fullName.startsWith("/")) {
			throw new Error(`tar entry path is absolute: ${fullName}`);
		}
		const relative = stripRoot(fullName);
		if (!relative) continue;
		const segments = normalizeSegments(relative);
		if (segments === undefined || segments.length === 0) {
			throw new Error(`tar entry path escapes the destination: ${fullName}`);
		}
		const dest = `${destDir}/${segments.join("/")}`;

		if (type === "5") {
			await ensureDir(dest);
		} else if (type === "2") {
			if (linkTarget.startsWith("/")) {
				throw new Error(`tar symlink target is absolute: ${fullName} -> ${linkTarget}`);
			}
			// Resolve the target against the link's directory; it must stay
			// inside destDir even before the workspace resolves anything.
			const resolved = normalizeSegments(`${segments.slice(0, -1).join("/")}/${linkTarget}`);
			if (resolved === undefined) {
				throw new Error(`tar symlink target escapes the destination: ${fullName} -> ${linkTarget}`);
			}
			await ensureDir(parentOf(dest));
			await target.symlink(linkTarget, dest);
		} else if (type === "0" || type === "\0" || type === "7") {
			await ensureDir(parentOf(dest));
			// Copy out of the rolling buffer: content is a subarray view.
			await target.writeFileBytes(dest, new Uint8Array(content));
			files += 1;
			bytes += size;
		}
		// Hardlinks and other exotic types don't occur in GitHub tarballs; skip.
	}
	return { files, bytes };
}
