/**
 * Sandbox Entry Point -- Worker Mailer SMTP
 *
 * Standard-format runtime entry for future sandboxed/marketplace use.
 * Configuration comes from plugin KV settings and Block Kit admin pages,
 * not constructor options.
 */

import { definePlugin } from "emdash";

import { createWorkerMailerHooks } from "./shared.js";

export default definePlugin({
	hooks: createWorkerMailerHooks(),
});
