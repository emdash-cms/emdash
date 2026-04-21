import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const RECOMMENDED = {
	card: "1600x900",
	hero: "2000x1125",
	logo: "600x240",
	favicon: "512x512",
};

function main() {
	const seedPath = resolve(process.cwd(), "seed/seed.json");
	if (!existsSync(seedPath)) {
		console.error(`Missing seed file: ${seedPath}`);
		process.exit(1);
	}

	const seed = JSON.parse(readFileSync(seedPath, "utf8"));
	const posts = seed?.content?.posts ?? [];
	const settings = seed?.settings ?? {};
	const warnings = [];

	for (const post of posts) {
		const image = post?.data?.featured_image;
		if (!image) {
			warnings.push(`Post "${post?.data?.title ?? post?.id ?? "unknown"}" has no featured image.`);
			continue;
		}
		if (!image.alt || !String(image.alt).trim()) {
			warnings.push(`Post "${post?.data?.title ?? post?.id ?? "unknown"}" featured image is missing alt text.`);
		}
	}

	if (settings.logo && !settings.logo.alt) {
		warnings.push("Site logo is missing alt text in settings.logo.alt.");
	}

	if (warnings.length > 0) {
		console.log("Image guardrails warnings:");
		for (const warning of warnings) {
			console.log(`- ${warning}`);
		}
		console.log("\nRecommended minimum sizes:");
		console.log(`- post cards: ${RECOMMENDED.card}`);
		console.log(`- post hero: ${RECOMMENDED.hero}`);
		console.log(`- logo: ${RECOMMENDED.logo}`);
		console.log(`- favicon: ${RECOMMENDED.favicon}`);
		process.exit(1);
	}

	console.log("Image guardrails check passed.");
}

main();
