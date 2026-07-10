/**
 * Shared CLI output helpers used by multiple commands. Lives here so a
 * change to the JSON-mode contract (e.g. tag/level formatting on stderr)
 * doesn't have to be touched in every command file.
 */

import consola from "consola";

/**
 * Reroute every consola log call to stderr. Used by `--json` mode so the
 * structured JSON object on stdout is the only thing a pipe consumer sees.
 *
 * Returns a restore function that puts the previous reporter set back. The
 * caller invokes it in a finally block so a wrapper script that runs a
 * command in-process and then continues with other commands gets its
 * consola back.
 *
 * We replace the global reporter (rather than constructing a separate
 * instance) so downstream helpers that import the default `consola`
 * singleton are also redirected.
 */
export function redirectConsolaToStderr(): () => void {
	const previous = consola.options.reporters?.slice() ?? [];
	consola.setReporters([
		{
			log(logObj) {
				const level = logObj.type ?? "info";
				const tag = logObj.tag ? `[${logObj.tag}] ` : "";
				const args = logObj.args ?? [];
				const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
				process.stderr.write(`${level}: ${tag}${message}\n`);
			},
		},
	]);
	return () => {
		consola.setReporters(previous);
	};
}
