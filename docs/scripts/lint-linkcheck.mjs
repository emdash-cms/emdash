import { readDocsBuildOutput } from "./lib/build-output.mjs";
import { buildPageIndex, findLinkIssues } from "./lib/linkcheck.mjs";

const site = "https://docs.emdashcms.com";

try {
	const { assetsDirectory, redirects } = readDocsBuildOutput(process.argv[2]);
	if (!assetsDirectory)
		throw new Error("The docs build does not contain a static asset directory.");
	const index = buildPageIndex(assetsDirectory);
	const { issues, links } = findLinkIssues(index, { site, redirects });
	if (issues.length > 0) {
		console.error(`Found ${issues.length} broken internal link(s):\n${issues.join("\n")}`);
		process.exitCode = 1;
	} else {
		console.log(`HTML pages checked: ${index.sources.length}; internal links checked: ${links}.`);
	}
} catch (error) {
	console.error(`Link check failed: ${error.message}`);
	process.exitCode = 1;
}
