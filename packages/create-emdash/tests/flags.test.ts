import { describe, expect, it } from "vitest";

import { FlagError, HELP_TEXT, parseFlags, validateProjectName, wantsHelp } from "../src/flags.js";

/**
 * `parseArgs` consumes argv from index 2 onward, mirroring `process.argv`.
 * Helper keeps tests readable.
 */
function argv(...args: string[]): string[] {
	return ["node", "create-emdash", ...args];
}

describe("parseFlags — defaults", () => {
	it("returns no values when called with no args", () => {
		const flags = parseFlags(argv());
		expect(flags).toEqual({ yes: false, force: false, help: false });
	});

	it("treats yes/force/help as false when omitted (not undefined)", () => {
		// Important: index.ts checks these directly, so they must be
		// boolean — never undefined.
		const flags = parseFlags(argv());
		expect(flags.yes).toBe(false);
		expect(flags.force).toBe(false);
		expect(flags.help).toBe(false);
	});
});

describe("parseFlags — positional name", () => {
	it("captures the project name from the first positional", () => {
		const flags = parseFlags(argv("my-blog"));
		expect(flags.name).toBe("my-blog");
	});

	it('accepts "." for current directory', () => {
		const flags = parseFlags(argv("."));
		expect(flags.name).toBe(".");
	});

	it("does NOT validate the name itself — that's the resolver's job", () => {
		// Validation moved to validateProjectName so the prompt path and the
		// flag path use the same rule with the same error message. parseFlags
		// is purely structural; it stores whatever the user typed. The
		// resolver enforces PROJECT_NAME_PATTERN before scaffolding.
		const flags = parseFlags(argv("My-Site"));
		expect(flags.name).toBe("My-Site");
	});

	it("accepts a positional after flags", () => {
		const flags = parseFlags(argv("--yes", "my-blog"));
		expect(flags.name).toBe("my-blog");
		expect(flags.yes).toBe(true);
	});

	it("rejects extra positionals as a likely typo", () => {
		// `npm create emdash my blog` (space instead of hyphen) is the
		// killer case: without this check it parses as name="my", drops
		// "blog" silently, and creates a project literally named "my".
		expect(() => parseFlags(argv("my", "blog"))).toThrow(FlagError);
		expect(() => parseFlags(argv("my", "blog"))).toThrow(/Unexpected extra/);
	});

	it("does not reject extra-position errors when the second token is a flag", () => {
		// argv ordering shouldn't trip the extra-positional check — flags
		// are removed by parseArgs before we count positionals.
		const flags = parseFlags(argv("my-blog", "--yes"));
		expect(flags.name).toBe("my-blog");
		expect(flags.yes).toBe(true);
	});
});

describe("validateProjectName", () => {
	it("returns undefined for a valid name", () => {
		expect(validateProjectName("my-site")).toBeUndefined();
		expect(validateProjectName("blog")).toBeUndefined();
		expect(validateProjectName("a")).toBeUndefined();
		expect(validateProjectName("123")).toBeUndefined();
	});

	it('returns undefined for "." (current-dir sentinel)', () => {
		expect(validateProjectName(".")).toBeUndefined();
	});

	it("returns an error message for invalid names", () => {
		expect(validateProjectName("My-Site")).toMatch(/lowercase letters/);
		expect(validateProjectName("my site")).toMatch(/lowercase letters/);
		expect(validateProjectName("my.site")).toMatch(/lowercase letters/);
	});
});

describe("parseFlags — --template", () => {
	it("accepts a bare template key", () => {
		expect(parseFlags(argv("--template", "blog")).template).toBe("blog");
		expect(parseFlags(argv("--template", "starter")).template).toBe("starter");
		expect(parseFlags(argv("--template", "marketing")).template).toBe("marketing");
		expect(parseFlags(argv("--template", "portfolio")).template).toBe("portfolio");
	});

	it("rejects unknown template keys", () => {
		expect(() => parseFlags(argv("--template", "nope"))).toThrow(FlagError);
		expect(() => parseFlags(argv("--template", "nope"))).toThrow(/--template/);
	});

	it("accepts the combined <platform>:<template> form", () => {
		const flags = parseFlags(argv("--template", "cloudflare:blog"));
		expect(flags.platform).toBe("cloudflare");
		expect(flags.template).toBe("blog");
	});

	it("accepts node:starter via the combined form", () => {
		const flags = parseFlags(argv("--template", "node:starter"));
		expect(flags.platform).toBe("node");
		expect(flags.template).toBe("starter");
	});

	it("rejects an unknown platform prefix in the combined form", () => {
		expect(() => parseFlags(argv("--template", "vercel:blog"))).toThrow(FlagError);
		expect(() => parseFlags(argv("--template", "vercel:blog"))).toThrow(/platform prefix/);
	});

	it("rejects an unknown template name in the combined form", () => {
		expect(() => parseFlags(argv("--template", "cloudflare:nope"))).toThrow(FlagError);
	});

	it("errors when --platform and --template platform-prefix disagree (platform first)", () => {
		// Easy to trip over if a user copies a flag set; surfacing an error
		// is friendlier than silently letting one win.
		expect(() => parseFlags(argv("--platform", "node", "--template", "cloudflare:blog"))).toThrow(
			FlagError,
		);
		expect(() => parseFlags(argv("--platform", "node", "--template", "cloudflare:blog"))).toThrow(
			/conflicts/,
		);
	});

	it("errors when --platform and --template platform-prefix disagree (template first)", () => {
		// Same as above but argv order reversed — conflict detection must
		// be order-independent. Without the reconcile-at-end pattern this
		// test passes by accident.
		expect(() => parseFlags(argv("--template", "cloudflare:blog", "--platform", "node"))).toThrow(
			FlagError,
		);
	});

	it("accepts --platform and --template platform-prefix when they agree", () => {
		const flags = parseFlags(argv("--platform", "cloudflare", "--template", "cloudflare:blog"));
		expect(flags.platform).toBe("cloudflare");
		expect(flags.template).toBe("blog");
	});

	it("rejects empty halves of the combined form", () => {
		expect(() => parseFlags(argv("--template", ":"))).toThrow(FlagError);
		expect(() => parseFlags(argv("--template", ":blog"))).toThrow(FlagError);
		expect(() => parseFlags(argv("--template", "cloudflare:"))).toThrow(FlagError);
	});

	it("treats subsequent colons as part of the template name (which then fails)", () => {
		// `cloudflare:blog:extra` -> platformPart="cloudflare", templatePart="blog:extra".
		// templatePart isn't a valid template, so we get the template error.
		expect(() => parseFlags(argv("--template", "cloudflare:blog:extra"))).toThrow(
			/--template name must be one of/,
		);
	});
});

describe("parseFlags — --platform", () => {
	it("accepts valid platforms", () => {
		expect(parseFlags(argv("--platform", "node")).platform).toBe("node");
		expect(parseFlags(argv("--platform", "cloudflare")).platform).toBe("cloudflare");
	});

	it("rejects unknown platforms", () => {
		expect(() => parseFlags(argv("--platform", "vercel"))).toThrow(FlagError);
	});
});

describe("parseFlags — package manager", () => {
	it("accepts --pm with valid managers", () => {
		expect(parseFlags(argv("--pm", "pnpm")).packageManager).toBe("pnpm");
		expect(parseFlags(argv("--pm", "npm")).packageManager).toBe("npm");
		expect(parseFlags(argv("--pm", "yarn")).packageManager).toBe("yarn");
		expect(parseFlags(argv("--pm", "bun")).packageManager).toBe("bun");
	});

	it("accepts --package-manager as an alias", () => {
		expect(parseFlags(argv("--package-manager", "pnpm")).packageManager).toBe("pnpm");
	});

	it("rejects unknown package managers", () => {
		expect(() => parseFlags(argv("--pm", "deno"))).toThrow(FlagError);
	});

	it("accepts --pm and --package-manager together when they agree", () => {
		const flags = parseFlags(argv("--pm", "pnpm", "--package-manager", "pnpm"));
		expect(flags.packageManager).toBe("pnpm");
	});

	it("errors when --pm and --package-manager disagree", () => {
		expect(() => parseFlags(argv("--pm", "pnpm", "--package-manager", "npm"))).toThrow(FlagError);
	});
});

describe("parseFlags — install toggle", () => {
	it("--install sets install: true", () => {
		expect(parseFlags(argv("--install")).install).toBe(true);
	});

	it("--no-install sets install: false", () => {
		expect(parseFlags(argv("--no-install")).install).toBe(false);
	});

	it("install is undefined when neither flag is passed", () => {
		expect(parseFlags(argv()).install).toBeUndefined();
	});

	it("errors when both --install and --no-install are passed", () => {
		expect(() => parseFlags(argv("--install", "--no-install"))).toThrow(FlagError);
	});
});

describe("parseFlags — --yes / -y", () => {
	it("--yes sets yes: true", () => {
		expect(parseFlags(argv("--yes")).yes).toBe(true);
	});

	it("-y sets yes: true", () => {
		expect(parseFlags(argv("-y")).yes).toBe(true);
	});
});

describe("parseFlags — --force", () => {
	it("--force sets force: true", () => {
		expect(parseFlags(argv("--force")).force).toBe(true);
	});

	it("force defaults to false", () => {
		expect(parseFlags(argv()).force).toBe(false);
	});

	it("--force composes with --yes", () => {
		const flags = parseFlags(argv("--yes", "--force"));
		expect(flags.yes).toBe(true);
		expect(flags.force).toBe(true);
	});
});

describe("wantsHelp", () => {
	it("returns true when --help is present", () => {
		expect(wantsHelp(["node", "script", "--help"])).toBe(true);
	});

	it("returns true when -h is present", () => {
		expect(wantsHelp(["node", "script", "-h"])).toBe(true);
	});

	it("returns true even when --help is preceded by an invalid flag", () => {
		// This is the whole point of wantsHelp — we want help even when
		// strict parseArgs would reject the rest of argv.
		expect(wantsHelp(["node", "script", "--templat", "x", "--help"])).toBe(true);
	});

	it("returns false when neither flag is present", () => {
		expect(wantsHelp(["node", "script"])).toBe(false);
		expect(wantsHelp(["node", "script", "my-blog", "--yes"])).toBe(false);
	});

	it("does not match a positional that happens to spell 'help'", () => {
		// A user passing `help` as a project name is invalid in
		// PROJECT_NAME_PATTERN terms (it's actually fine — `help` is
		// lowercase letters), but the point is wantsHelp matches the flag
		// only, not arbitrary tokens.
		expect(wantsHelp(["node", "script", "help"])).toBe(false);
	});
});

describe("parseFlags — --help / -h", () => {
	it("--help sets help: true", () => {
		expect(parseFlags(argv("--help")).help).toBe(true);
	});

	it("-h sets help: true", () => {
		expect(parseFlags(argv("-h")).help).toBe(true);
	});
});

describe("parseFlags — unknown flags", () => {
	it("throws on unknown flags rather than silently ignoring them", () => {
		// parseArgs in strict mode (the default) throws TypeError. We
		// don't re-wrap it because the message it produces is already
		// user-facing-friendly: 'Unknown option \'--templat\''.
		expect(() => parseFlags(argv("--templat", "blog"))).toThrow();
	});
});

describe("parseFlags — full one-shot install line", () => {
	it("parses the example from the issue", () => {
		const flags = parseFlags(
			argv("my-blog", "--template", "cloudflare:blog", "--pm", "pnpm", "--yes"),
		);
		expect(flags).toEqual({
			name: "my-blog",
			platform: "cloudflare",
			template: "blog",
			packageManager: "pnpm",
			yes: true,
			force: false,
			help: false,
		});
	});

	it("parses split-flag form", () => {
		const flags = parseFlags(
			argv(
				"my-blog",
				"--platform",
				"node",
				"--template",
				"starter",
				"--pm",
				"npm",
				"--no-install",
				"--yes",
			),
		);
		expect(flags).toEqual({
			name: "my-blog",
			platform: "node",
			template: "starter",
			packageManager: "npm",
			install: false,
			yes: true,
			force: false,
			help: false,
		});
	});

	it("parses cwd-overwrite form (--yes . --force)", () => {
		const flags = parseFlags(argv(".", "--yes", "--force"));
		expect(flags.name).toBe(".");
		expect(flags.yes).toBe(true);
		expect(flags.force).toBe(true);
	});
});

describe("HELP_TEXT", () => {
	it("documents every supported flag", () => {
		// Cheap lint to keep HELP_TEXT in sync with parseFlags. If you
		// add a new flag and don't document it, this fails.
		for (const flag of [
			"--template",
			"--platform",
			"--pm",
			"--package-manager",
			"--install",
			"--no-install",
			"--yes",
			"--force",
			"--help",
		]) {
			expect(HELP_TEXT).toContain(flag);
		}
	});

	it("documents the short-form aliases", () => {
		expect(HELP_TEXT).toContain("-y");
		expect(HELP_TEXT).toContain("-h");
	});
});
