import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const REQUIRED_KEYS = [
	"DATABASE_URL",
	"S3_ENDPOINT",
	"S3_BUCKET",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"S3_REGION",
	"S3_PUBLIC_URL",
];

const OPTIONAL_KEYS = ["SITE_URL"];

function parseArgs(argv) {
	const providerArg = argv.find((arg) => arg.startsWith("--provider="));
	if (!providerArg) return "";
	const provider = providerArg.slice("--provider=".length).trim().toLowerCase();
	return provider === "vercel" || provider === "netlify" ? provider : "";
}

function parseDotEnv(content) {
	const env = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const splitIndex = trimmed.indexOf("=");
		if (splitIndex <= 0) continue;
		const key = trimmed.slice(0, splitIndex).trim();
		const value = trimmed.slice(splitIndex + 1).trim();
		env[key] = value;
	}
	return env;
}

function serializeEnv(current) {
	return [...REQUIRED_KEYS, ...OPTIONAL_KEYS]
		.map((key) => `${key}=${current[key] ?? ""}`)
		.join("\n");
}

function preflightErrors(env) {
	const errors = [];
	for (const key of REQUIRED_KEYS) {
		if (!env[key]) {
			errors.push(`Missing ${key}`);
		}
	}

	if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
		errors.push("DATABASE_URL should be a postgres connection string for serverless deployments");
	}

	if (env.S3_ENDPOINT && !/^https?:\/\//.test(env.S3_ENDPOINT)) {
		errors.push("S3_ENDPOINT must start with http:// or https://");
	}

	if (env.S3_PUBLIC_URL && !/^https?:\/\//.test(env.S3_PUBLIC_URL)) {
		errors.push("S3_PUBLIC_URL must start with http:// or https://");
	}

	return errors;
}

function providerHint(provider) {
	if (provider === "vercel") {
		return "Next: add these variables in your Vercel Project Settings -> Environment Variables.";
	}
	if (provider === "netlify") {
		return "Next: add these variables in Netlify Site Configuration -> Environment Variables.";
	}
	return "Next: add these variables in your hosting provider's environment settings.";
}

function main() {
	const provider = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();
	const envPath = resolve(cwd, ".env");
	const envExamplePath = resolve(cwd, ".env.example");

	let env = {};
	if (existsSync(envPath)) {
		env = parseDotEnv(readFileSync(envPath, "utf8"));
	} else if (existsSync(envExamplePath)) {
		env = parseDotEnv(readFileSync(envExamplePath, "utf8"));
	} else {
		for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
			env[key] = "";
		}
	}

	for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
		if (!(key in env)) env[key] = "";
	}

	writeFileSync(envPath, `${serializeEnv(env)}\n`);
	console.log(`Wrote ${envPath}`);

	const errors = preflightErrors(env);
	if (errors.length > 0) {
		console.log("\nHosting preflight failed:");
		for (const error of errors) {
			console.log(`- ${error}`);
		}
		console.log(`\n${providerHint(provider)}`);
		process.exit(1);
	}

	console.log("\nHosting preflight passed.");
	console.log(providerHint(provider));
}

main();
