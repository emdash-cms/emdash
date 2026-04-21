import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const SEED_PATH = resolve(process.cwd(), "seed/seed.json");

function main() {
	if (!existsSync(SEED_PATH)) {
		console.error(`Missing seed file: ${SEED_PATH}`);
		process.exit(1);
	}

	const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
	const settings = seed?.settings ?? {};
	const errors = [];
	const warnings = [];

	if (!settings.title || !String(settings.title).trim()) {
		errors.push("settings.title is required for SEO and schema metadata.");
	}

	if (!settings.url || !/^https?:\/\//.test(String(settings.url))) {
		errors.push("settings.url should be an absolute http/https site URL for canonical and sitemap links.");
	}

	if (!settings.phone && !settings.email) {
		warnings.push("LocalBusiness schema is stronger when phone or email is set.");
	}

	if (!settings.address && !settings.locality) {
		warnings.push("Set address/locality for local SEO relevance.");
	}

	if (errors.length > 0) {
		console.log("SEO preflight failed:");
		for (const error of errors) {
			console.log(`- ${error}`);
		}
		if (warnings.length > 0) {
			console.log("\nSEO warnings:");
			for (const warning of warnings) {
				console.log(`- ${warning}`);
			}
		}
		process.exit(1);
	}

	if (warnings.length > 0) {
		console.log("SEO preflight passed with warnings:");
		for (const warning of warnings) {
			console.log(`- ${warning}`);
		}
		process.exit(0);
	}

	console.log("SEO preflight passed.");
}

main();
