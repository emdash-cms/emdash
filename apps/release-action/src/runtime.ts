import { appendFile } from "node:fs/promises";

const OUTPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_OIDC_TOKEN_CHARS = 16 * 1024;

export interface ActionRuntime {
	getInput(name: string, options?: { required?: boolean }): string;
	getIDToken(audience: string): Promise<string>;
	addMask(value: string): void;
	setOutput(name: string, value: string): Promise<void>;
	writeSummary(markdown: string): Promise<void>;
	info(message: string): void;
	setFailed(message: string): void;
	getEnvironment(name: string): string | undefined;
}

function commandValue(value: string): string {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function inputEnvironmentName(name: string): string {
	return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}

export class DefaultActionRuntime implements ActionRuntime {
	getInput(name: string, options: { required?: boolean } = {}): string {
		const value = process.env[inputEnvironmentName(name)]?.trim() ?? "";
		if (options.required && value.length === 0) {
			throw new Error(`Required input is missing: ${name}`);
		}
		return value;
	}

	async getIDToken(audience: string): Promise<string> {
		const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
		const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
		if (!requestUrl || !requestToken) throw new Error("GitHub OIDC is unavailable");
		let url: URL;
		try {
			url = new URL(requestUrl);
			if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
				throw new Error("invalid OIDC URL");
			}
			url.searchParams.set("audience", audience);
		} catch {
			throw new Error("GitHub OIDC is unavailable");
		}
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${requestToken}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error("GitHub OIDC request failed");
		const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		if (mediaType !== "application/json") throw new Error("GitHub OIDC response is invalid");
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("GitHub OIDC response is invalid");
		}
		if (
			payload === null ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			!("value" in payload) ||
			typeof payload.value !== "string" ||
			payload.value.length === 0 ||
			payload.value.length > MAX_OIDC_TOKEN_CHARS
		) {
			throw new Error("GitHub OIDC response is invalid");
		}
		return payload.value;
	}

	addMask(value: string): void {
		console.log(`::add-mask::${commandValue(value)}`);
	}

	async setOutput(name: string, value: string): Promise<void> {
		if (!OUTPUT_NAME_PATTERN.test(name)) throw new Error("Action output name is invalid");
		const outputFile = process.env["GITHUB_OUTPUT"];
		if (!outputFile) throw new Error("GitHub output file is unavailable");
		const delimiter = `emdash_${crypto.randomUUID()}`;
		await appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
	}

	async writeSummary(markdown: string): Promise<void> {
		const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
		if (!summaryFile) return;
		await appendFile(summaryFile, `${markdown}\n`, "utf8");
	}

	info(message: string): void {
		console.log(message);
	}

	setFailed(message: string): void {
		console.error(`::error::${commandValue(message)}`);
		process.exitCode = 1;
	}

	getEnvironment(name: string): string | undefined {
		return process.env[name];
	}
}
