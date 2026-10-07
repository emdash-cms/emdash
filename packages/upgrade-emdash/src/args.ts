import semver from "semver";

const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

export interface CliOptions {
	cwd: string;
	tag: string;
	dryRun: boolean;
	json: boolean;
	yes: boolean;
	help: boolean;
	version: boolean;
}

export const HELP = `Upgrade an EmDash project to an npm release tag.

Usage:
  npx upgrade-emdash@latest [options]

Options:
  --cwd <path>  Project directory (default: current directory)
  --to <tag>    npm dist-tag to install (default: latest)
  --dry-run     Inspect the upgrade without changing files
  -y, --yes     Apply without an interactive confirmation
  --json        Emit the dry-run plan as JSON
  -h, --help    Show this help
  -v, --version Show the updater version
`;

export function parseArgs(args: readonly string[], cwd = process.cwd()): CliOptions {
	const options: CliOptions = {
		cwd,
		tag: "latest",
		dryRun: false,
		json: false,
		yes: false,
		help: false,
		version: false,
	};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		switch (argument) {
			case "--cwd": {
				const path = args[index + 1];
				if (!path) throw new Error("--cwd requires a path.");
				options.cwd = path;
				index++;
				break;
			}
			case "--to": {
				const tag = args[index + 1];
				if (!tag) throw new Error("--to requires an npm dist-tag.");
				options.tag = tag;
				index++;
				break;
			}
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--json":
				options.json = true;
				options.dryRun = true;
				break;
			case "--version":
			case "-v":
				options.version = true;
				break;
			case "--yes":
			case "-y":
				options.yes = true;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	if (options.json && options.yes) {
		throw new Error("--json reports a dry-run plan and cannot be combined with --yes.");
	}
	if (!DIST_TAG.test(options.tag) || semver.validRange(options.tag)) {
		throw new Error("--to accepts an npm dist-tag such as latest, next, or beta, not a version.");
	}
	return options;
}
