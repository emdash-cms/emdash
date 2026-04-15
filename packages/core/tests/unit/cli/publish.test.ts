import { describe, expect, it } from "vitest";

import { createGitHubDeviceFlowBody } from "../../../src/cli/commands/publish.js";

describe("createGitHubDeviceFlowBody", () => {
	it("encodes GitHub device-flow params as form data", () => {
		const body = createGitHubDeviceFlowBody({
			client_id: "emdash-cli",
			scope: "read:user user:email",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});

		expect(body).toBe(
			"client_id=emdash-cli&scope=read%3Auser+user%3Aemail&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
		);
		expect(body).not.toContain("{");
		expect(body).not.toContain('"client_id"');
	});
});
