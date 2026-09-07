import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Dialect,
	Driver,
	Kysely,
	QueryResult,
} from "kysely";
import { SqliteQueryCompiler } from "kysely";

import { D1Adapter } from "./d1-dialect.js";
import { D1Introspector } from "./d1-introspector.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const JSON_CONTENT_TYPE_PATTERN = /^application\/(?:[a-z0-9.+-]+\+)?json\b/i;
const READ_STATEMENT_PATTERN = /^\s*(?:select|explain)\b/i;

type JsonParameter = string | number | null | number[];

export interface D1RestDialectConfig {
	accountId: string;
	databaseId: string;
	token: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export class D1RestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "D1RestError";
	}
}

export class D1AmbiguousWriteError extends D1RestError {
	constructor() {
		super(
			"The D1 write outcome is ambiguous because its response was not received safely. Run `emdash migrate --status` before retrying.",
		);
		this.name = "D1AmbiguousWriteError";
	}
}

class D1DefinitiveResponseError extends D1RestError {}

interface ValidatedStatementResult {
	rows: Record<string, unknown>[];
	changes: number;
	lastRowId: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, name: string, nullable = false): number | null {
	if (nullable && value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new D1RestError(`D1 response metadata field ${name} is invalid.`);
	}
	return value;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new D1RestError(`D1 response metadata field ${name} is invalid.`);
	}
	return value;
}

function validateMessages(value: unknown, name: string): Array<{ code: number; message: string }> {
	if (!Array.isArray(value)) throw new D1RestError(`D1 response ${name} is invalid.`);
	return value.map((item) => {
		if (
			!isRecord(item) ||
			typeof item.code !== "number" ||
			!Number.isSafeInteger(item.code) ||
			typeof item.message !== "string"
		) {
			throw new D1RestError(`D1 response ${name} is invalid.`);
		}
		return { code: item.code, message: item.message };
	});
}

function redactMessage(message: string, token: string): string {
	const safe: string[] = [];
	let length = 0;
	for (let index = 0; index < message.length && length < 1_000;) {
		let chunk: string;
		if (token && message.startsWith(token, index)) {
			chunk = "[redacted]";
			index += token.length;
		} else {
			const code = message.codePointAt(index)!;
			chunk = code < 0x20 || code === 0x7f ? " " : String.fromCodePoint(code);
			index += code > 0xffff ? 2 : 1;
		}
		const remaining = 1_000 - length;
		const bounded = chunk.slice(0, remaining);
		safe.push(bounded);
		length += bounded.length;
	}
	return safe.join("");
}

function validateStatementResponse(value: unknown, token: string): ValidatedStatementResult {
	if (!isRecord(value)) throw new D1RestError("D1 response envelope is invalid.");
	const errors = validateMessages(value.errors, "errors");
	validateMessages(value.messages, "messages");
	if (value.success !== true) {
		const message = errors.map((error) => error.message).join("; ") || "Cloudflare API failure";
		throw new D1DefinitiveResponseError(`D1 API request failed: ${redactMessage(message, token)}`);
	}
	if (errors.length !== 0 || !Array.isArray(value.result) || value.result.length !== 1) {
		throw new D1RestError("D1 response envelope is invalid.");
	}
	const statement = value.result[0];
	if (!isRecord(statement) || typeof statement.success !== "boolean") {
		throw new D1RestError("D1 statement response is invalid.");
	}
	if (!statement.success) {
		if (typeof statement.error !== "string" || statement.error.length === 0) {
			throw new D1RestError("D1 statement response is invalid.");
		}
		throw new D1DefinitiveResponseError(
			`D1 query failed: ${redactMessage(statement.error, token)}`,
		);
	}
	if (!Array.isArray(statement.results) || !statement.results.every(isRecord)) {
		throw new D1RestError("D1 statement rows are invalid.");
	}
	if (!isRecord(statement.meta)) throw new D1RestError("D1 response metadata is invalid.");
	const meta = statement.meta;
	if (typeof meta.changed_db !== "boolean") {
		throw new D1RestError("D1 response metadata field changed_db is invalid.");
	}
	const changes = safeInteger(meta.changes, "changes");
	const lastRowId = safeInteger(meta.last_row_id, "last_row_id", true);
	finiteNumber(meta.duration, "duration");
	safeInteger(meta.rows_read, "rows_read");
	safeInteger(meta.rows_written, "rows_written");
	safeInteger(meta.size_after, "size_after");
	if (changes === null) throw new D1RestError("D1 response metadata field changes is invalid.");
	return { rows: statement.results, changes, lastRowId };
}

function normalizeParameter(value: unknown): JsonParameter {
	if (value === null || typeof value === "string") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new D1RestError("D1 query parameter is not a safe finite number.");
		}
		return value;
	}
	if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
	if (ArrayBuffer.isView(value)) {
		return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
	}
	throw new D1RestError("D1 query parameter type is unsupported.");
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
		throw new D1RestError("D1 response content type is not JSON.");
	}
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
			throw new D1RestError("D1 response is too large.");
		}
	}
	if (!response.body) throw new D1RestError("D1 response body is missing.");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new D1RestError("D1 response is too large.");
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new D1RestError("D1 response body is not valid JSON.");
	}
}

class D1RestTransport {
	readonly #config: Required<Omit<D1RestDialectConfig, "fetch">> & {
		fetch: typeof globalThis.fetch;
	};
	readonly #controllers = new Set<AbortController>();
	#destroyed = false;

	constructor(config: D1RestDialectConfig) {
		this.#config = {
			accountId: config.accountId,
			databaseId: config.databaseId,
			token: config.token,
			fetch: config.fetch ?? globalThis.fetch,
			timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
		};
	}

	async query(sql: string, parameters: readonly unknown[]): Promise<ValidatedStatementResult> {
		const params = parameters.map(normalizeParameter);
		if (this.#destroyed) throw new D1RestError("The D1 REST transport has been disposed.");
		const controller = new AbortController();
		this.#controllers.add(controller);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.#config.timeoutMs);
		const isWrite = !READ_STATEMENT_PATTERN.test(sql);

		try {
			const response = await this.#config.fetch(
				`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.#config.accountId)}/d1/database/${encodeURIComponent(this.#config.databaseId)}/query`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#config.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ sql, params }),
					redirect: "error",
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				if (isWrite && response.status >= 500) throw new D1AmbiguousWriteError();
				throw new D1DefinitiveResponseError(
					`D1 API request failed with HTTP status ${response.status}.`,
				);
			}
			const body = await readBoundedJson(response, this.#config.maxResponseBytes);
			return validateStatementResponse(body, this.#config.token);
		} catch (error) {
			if (error instanceof D1AmbiguousWriteError) throw error;
			if (error instanceof D1DefinitiveResponseError) throw error;
			if (isWrite) throw new D1AmbiguousWriteError();
			if (error instanceof D1RestError) throw error;
			if (timedOut) throw new D1RestError("D1 query timed out.");
			throw new D1RestError("D1 query request failed before a valid response was received.");
		} finally {
			clearTimeout(timer);
			this.#controllers.delete(controller);
		}
	}

	destroy(): void {
		this.#destroyed = true;
		for (const controller of this.#controllers) controller.abort();
		this.#controllers.clear();
	}
}

export class D1RestDialect implements Dialect {
	readonly #config: D1RestDialectConfig;

	constructor(config: D1RestDialectConfig) {
		this.#config = config;
	}

	createAdapter(): D1Adapter {
		return new D1Adapter();
	}

	createDriver(): Driver {
		return new D1RestDriver(this.#config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

class D1RestDriver implements Driver {
	readonly #transport: D1RestTransport;

	constructor(config: D1RestDialectConfig) {
		this.#transport = new D1RestTransport(config);
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return new D1RestConnection(this.#transport);
	}

	async beginTransaction(): Promise<void> {
		throw new Error("Transactions are not supported yet.");
	}

	async commitTransaction(): Promise<void> {
		throw new Error("Transactions are not supported yet.");
	}

	async rollbackTransaction(): Promise<void> {
		throw new Error("Transactions are not supported yet.");
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {
		this.#transport.destroy();
	}
}

class D1RestConnection implements DatabaseConnection {
	readonly #transport: D1RestTransport;

	constructor(transport: D1RestTransport) {
		this.#transport = transport;
	}

	async executeQuery<Row>(compiledQuery: CompiledQuery): Promise<QueryResult<Row>> {
		const result = await this.#transport.query(compiledQuery.sql, compiledQuery.parameters);
		return {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated row objects are mapped to Kysely's caller-selected row type
			rows: result.rows as Row[],
			numAffectedRows: BigInt(result.changes),
			insertId: result.lastRowId === null ? undefined : BigInt(result.lastRowId),
		};
	}

	// eslint-disable-next-line require-yield -- the administrative D1 transport does not stream
	async *streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
		throw new Error("D1 REST dialect does not support streaming.");
	}
}
