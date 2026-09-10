export interface ParseSuccess<T> {
	success: true;
	data: T;
}

export interface ParseFailure {
	success: false;
	error: TypeError;
}

export interface RuntimeSchema<T> {
	parse(value: unknown): T;
	safeParse(value: unknown): ParseSuccess<T> | ParseFailure;
}

export function runtimeSchema<T>(parser: (value: unknown) => T): RuntimeSchema<T> {
	return {
		parse: parser,
		safeParse(value) {
			try {
				return { success: true, data: parser(value) };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof TypeError ? error : new TypeError("Invalid value", { cause: error }),
				};
			}
		},
	};
}

export function record(
	value: unknown,
	field: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object`);
	}
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new TypeError(`${field} contains unsupported field: ${key}`);
		output[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
	}
	return output;
}

export function dictionary(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object`);
	}
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		output[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
	}
	return output;
}

export function stringValue(value: unknown, field: string, maxLength = 20_000): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}

export function optionalString(
	value: unknown,
	field: string,
	maxLength?: number,
): string | undefined {
	return value === undefined ? undefined : stringValue(value, field, maxLength);
}

export function stringArray(value: unknown, field: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new TypeError(`${field} must be an array of at most ${maxItems} strings`);
	}
	return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

export function optionalInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative integer`);
	}
	return value;
}

export function integerValue(value: unknown, field: string): number {
	const parsed = optionalInteger(value, field);
	if (parsed === undefined) throw new TypeError(`${field} is required`);
	return parsed;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
	return value;
}
