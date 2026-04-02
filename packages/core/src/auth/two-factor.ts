const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const BASE32_PADDING_REGEX = /=+$/g;
const WHITESPACE_REGEX = /\s+/g;
const NON_DIGITS_REGEX = /\D/g;
const SIX_DIGIT_CODE_REGEX = /^\d{6}$/;

interface TwoFactorData {
	enabled: boolean;
	secret?: string;
	pendingSecret?: string;
	enabledAt?: string;
}

interface UserDataContainer {
	data: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime guarded above
	return value as Record<string, unknown>;
}

function getTwoFactorDataFromRecord(record: Record<string, unknown> | null): TwoFactorData {
	if (!record) return { enabled: false };
	const raw = asRecord(record.twoFactor);
	if (!raw) return { enabled: false };

	return {
		enabled: raw.enabled === true,
		secret: typeof raw.secret === "string" ? raw.secret : undefined,
		pendingSecret: typeof raw.pendingSecret === "string" ? raw.pendingSecret : undefined,
		enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : undefined,
	};
}

function writeTwoFactorData(
	record: Record<string, unknown> | null,
	twoFactor: TwoFactorData,
): Record<string, unknown> {
	const next = { ...record };
	const nextTwoFactor: Record<string, unknown> = {
		enabled: twoFactor.enabled,
	};
	if (twoFactor.secret) nextTwoFactor.secret = twoFactor.secret;
	if (twoFactor.pendingSecret) nextTwoFactor.pendingSecret = twoFactor.pendingSecret;
	if (twoFactor.enabledAt) nextTwoFactor.enabledAt = twoFactor.enabledAt;
	next.twoFactor = nextTwoFactor;
	return next;
}

export function getTwoFactorState(user: UserDataContainer): TwoFactorData {
	return getTwoFactorDataFromRecord(user.data);
}

export function isTwoFactorEnabled(user: UserDataContainer): boolean {
	const twoFactor = getTwoFactorDataFromRecord(user.data);
	return twoFactor.enabled && !!twoFactor.secret;
}

export function setTwoFactorPendingSecret(
	userData: Record<string, unknown> | null,
	secret: string,
): Record<string, unknown> {
	const current = getTwoFactorDataFromRecord(userData);
	return writeTwoFactorData(userData, {
		...current,
		enabled: false,
		pendingSecret: secret,
	});
}

export function enableTwoFactor(
	userData: Record<string, unknown> | null,
	secret: string,
): Record<string, unknown> {
	return writeTwoFactorData(userData, {
		enabled: true,
		secret,
		enabledAt: new Date().toISOString(),
	});
}

export function disableTwoFactor(userData: Record<string, unknown> | null): Record<string, unknown> {
	return writeTwoFactorData(userData, { enabled: false });
}

function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";

	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;

		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
			bits -= 5;
		}
	}

	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";
	}

	return output;
}

function base32Decode(input: string): Uint8Array {
	const normalized = input
		.toUpperCase()
		.replace(BASE32_PADDING_REGEX, "")
		.replace(WHITESPACE_REGEX, "");
	let bits = 0;
	let value = 0;
	const output: number[] = [];

	for (const char of normalized) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) {
			throw new Error("Invalid base32 secret");
		}

		value = (value << 5) | index;
		bits += 5;

		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}

	return Uint8Array.from(output);
}

function normalizeCode(code: string): string {
	return code.replace(NON_DIGITS_REGEX, "");
}

function formatCounter(counter: number): Uint8Array {
	const out = new Uint8Array(8);
	let remaining = BigInt(counter);
	for (let i = 7; i >= 0; i--) {
		out[i] = Number(remaining & 255n);
		remaining >>= 8n;
	}
	return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out.buffer;
}

async function generateHotp(secret: string, counter: number, digits = TOTP_DIGITS): Promise<string> {
	const keyBytes = base32Decode(secret);
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(keyBytes),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, toArrayBuffer(formatCounter(counter))),
	);
	const offset = (signature.at(-1) ?? 0) & 0x0f;
	const binary =
		(((signature[offset] ?? 0) & 0x7f) << 24) |
		(((signature[offset + 1] ?? 0) & 0xff) << 16) |
		(((signature[offset + 2] ?? 0) & 0xff) << 8) |
		((signature[offset + 3] ?? 0) & 0xff);
	const otp = binary % 10 ** digits;
	return otp.toString().padStart(digits, "0");
}

function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

export function generateTwoFactorSecret(): string {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	return base32Encode(bytes);
}

export function buildOtpAuthUrl(secret: string, accountName: string, issuer: string): string {
	const label = `${issuer}:${accountName}`;
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: "SHA1",
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD_SECONDS),
	});
	return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export async function verifyTwoFactorCode(
	secret: string,
	code: string,
	now = Date.now(),
): Promise<boolean> {
	const normalizedCode = normalizeCode(code);
	if (!SIX_DIGIT_CODE_REGEX.test(normalizedCode)) return false;

	const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
	for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
		const expected = await generateHotp(secret, counter + offset);
		if (constantTimeEquals(expected, normalizedCode)) return true;
	}

	return false;
}
