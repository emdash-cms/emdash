import type { ReviewFile } from "./types.js";

// The registry's per-file limit (MAX_BUNDLE_FILE_BYTES), so any file it
// accepts is read in one call.
export const READ_WINDOW_CHARS = 131_072;
const MAX_SEARCH_MATCHES = 50;
const SEARCH_CONTEXT_CHARS = 120;
const MAX_REGEX_LENGTH = 200;

interface IndexedFile {
	path: string;
	byteLength: number;
	text?: string;
	lineStarts: number[];
	read: [number, number][];
}

/**
 * The bundle as the reviewer sees it: read-only, in memory, with every read
 * recorded so trusted code can tell whether each text file was read in full.
 */
export class BundleWorkspace {
	readonly #files = new Map<string, IndexedFile>();
	readonly #token: string;

	constructor(files: readonly ReviewFile[], token: string) {
		this.#token = token;
		for (const file of files) {
			this.#files.set(file.path, {
				path: file.path,
				byteLength: file.byteLength,
				...(file.text === undefined ? {} : { text: file.text }),
				lineStarts: file.text === undefined ? [] : lineStarts(file.text),
				read: [],
			});
		}
	}

	fence(body: string): string {
		return `<<<BUNDLE ${this.#token}>>>\n${body}\n<<<END BUNDLE ${this.#token}>>>`;
	}

	listFiles(): string {
		const rows = Array.from(this.#files.values(), (file) =>
			file.text === undefined
				? `${file.path}\t${file.byteLength} bytes\tbinary, not readable`
				: `${file.path}\t${file.text.length} characters\t${file.lineStarts.length} lines`,
		);
		return this.fence(rows.join("\n"));
	}

	readFile(path: string, offset = 0): string {
		const file = this.#textFile(path);
		const text = file.text ?? "";
		if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= text.length)) {
			throw new ToolInputError(`offset must be an integer between 0 and ${text.length - 1}`);
		}
		const end = Math.min(text.length, offset + READ_WINDOW_CHARS);
		file.read.push([offset, end]);
		const firstLine = lineAt(file.lineStarts, offset);
		const rendered: string[] = [];
		for (let line = firstLine; line <= file.lineStarts.length; line += 1) {
			const lineStart = file.lineStarts[line - 1] ?? 0;
			if (lineStart >= end && line !== firstLine) break;
			const lineEnd = file.lineStarts[line] ?? text.length + 1;
			const from = Math.max(lineStart, offset);
			const to = Math.min(lineEnd - 1, end);
			const marker = from > lineStart ? "+" : " ";
			rendered.push(`${String(line).padStart(6)}${marker}| ${text.slice(from, to)}`);
		}
		const header = `file ${path}, characters ${offset}-${end} of ${text.length}${
			end < text.length ? `; continue with read_file offset ${end}` : "; end of file"
		}. A "+" after a line number means the line started before this window.`;
		return `${header}\n${this.fence(rendered.join("\n"))}`;
	}

	search(query: string, options: { path?: string; regex?: boolean; ignoreCase?: boolean }): string {
		if (query.length === 0) throw new ToolInputError("query must not be empty");
		const pattern = searchPattern(query, options);
		const files = options.path ? [this.#textFile(options.path)] : [...this.#files.values()];
		const matches: string[] = [];
		let total = 0;
		for (const file of files) {
			if (file.text === undefined) continue;
			for (const match of file.text.matchAll(pattern)) {
				if (match[0].length === 0) continue;
				total += 1;
				if (matches.length >= MAX_SEARCH_MATCHES) continue;
				const line = lineAt(file.lineStarts, match.index);
				const lineStart = file.lineStarts[line - 1] ?? 0;
				const lineEnd = (file.lineStarts[line] ?? file.text.length + 1) - 1;
				const from = Math.max(lineStart, match.index - SEARCH_CONTEXT_CHARS);
				const to = Math.min(lineEnd, match.index + match[0].length + SEARCH_CONTEXT_CHARS);
				matches.push(`${file.path}:${line}: ${file.text.slice(from, to)}`);
			}
		}
		const header =
			total > matches.length
				? `${total} matches; showing the first ${matches.length}. Narrow the query or path.`
				: `${total} matches.`;
		return `${header}\n${this.fence(matches.join("\n"))}`;
	}

	/** Text files with character ranges the reviewer has not read. */
	unreadRanges(): string[] {
		const unread: string[] = [];
		for (const file of this.#files.values()) {
			if (file.text === undefined || file.text.length === 0) continue;
			let covered = 0;
			for (const [start, end] of file.read.toSorted((left, right) => left[0] - right[0])) {
				if (start > covered) break;
				covered = Math.max(covered, end);
			}
			if (covered < file.text.length) {
				unread.push(`${file.path} from offset ${covered} of ${file.text.length}`);
			}
		}
		return unread;
	}

	/** The text of a line, or undefined when the file or line does not exist. */
	line(path: string, line: number): string | undefined {
		const file = this.#files.get(path);
		if (file?.text === undefined || !Number.isInteger(line) || line < 1) return undefined;
		const start = file.lineStarts[line - 1];
		if (start === undefined) return undefined;
		const end = (file.lineStarts[line] ?? file.text.length + 1) - 1;
		return file.text.slice(start, end);
	}

	#textFile(path: string): IndexedFile {
		const file = this.#files.get(path);
		if (!file) throw new ToolInputError(`no file named ${JSON.stringify(path)}; call list_files`);
		if (file.text === undefined) throw new ToolInputError(`${path} is binary and cannot be read`);
		return file;
	}
}

export class ToolInputError extends Error {
	override readonly name = "ToolInputError";
}

function searchPattern(query: string, options: { regex?: boolean; ignoreCase?: boolean }): RegExp {
	const flags = options.ignoreCase ? "gi" : "g";
	if (!options.regex) return new RegExp(escapeRegExp(query), flags);
	if (query.length > MAX_REGEX_LENGTH) {
		throw new ToolInputError(`regex queries are limited to ${MAX_REGEX_LENGTH} characters`);
	}
	try {
		return new RegExp(query, flags);
	} catch {
		throw new ToolInputError("query is not a valid regular expression");
	}
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		starts.push(index + 1);
	}
	return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((starts[middle] ?? 0) <= offset) low = middle;
		else high = middle - 1;
	}
	return low + 1;
}
