import { gzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import {
	createPushCapability,
	gateGithubRequest,
	githubAuthHeader,
	githubGateDenialResponse,
	githubPushUrl,
	inspectGithubRequest,
	pushCapabilityFromAuthorization,
	withGithubAuthorization,
	verifyPushCapability,
} from "../../.flue/lib/github-proxy.js";

const OWNER = "emdash-cms";
const REPO = "emdash";

function gate(url: string, init?: RequestInit) {
	const request = new Request(url, init);
	return gateGithubRequest(request, new URL(url), OWNER, REPO, 123);
}

describe("githubAuthHeader", () => {
	test("uses Bearer for api.github.com", () => {
		expect(githubAuthHeader("api.github.com", "tok_abc")).toBe("Bearer tok_abc");
	});

	test("uses Basic x-access-token for git hosts", () => {
		expect(githubAuthHeader("github.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
		expect(githubAuthHeader("codeload.github.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
		expect(githubAuthHeader("raw.githubusercontent.com", "tok_abc")).toBe(
			`Basic ${btoa("x-access-token:tok_abc")}`,
		);
	});
});

describe("push capabilities", () => {
	test("travels as standard Basic credentials on the push URL", async () => {
		const capability = await createPushCapability("webhook-secret", OWNER, REPO, 123);
		const url = new URL(githubPushUrl(OWNER, REPO, capability));
		const authorization = `Basic ${btoa(`${url.username}:${url.password}`)}`;

		expect(url.origin).toBe("https://github.com");
		expect(url.pathname).toBe(`/${OWNER}/${REPO}.git`);
		expect(pushCapabilityFromAuthorization(authorization)).toBe(capability);
	});

	test("rejects malformed or unrelated Basic credentials", () => {
		expect(pushCapabilityFromAuthorization(null)).toBeNull();
		expect(pushCapabilityFromAuthorization("Bearer sandbox-capability")).toBeNull();
		expect(pushCapabilityFromAuthorization("Basic not-base64!")).toBeNull();
		expect(
			pushCapabilityFromAuthorization(`Basic ${btoa("someone-else:123.signature")}`),
		).toBeNull();
		expect(pushCapabilityFromAuthorization(`Basic ${btoa("emdashbot:")}`)).toBeNull();
	});

	test("strips sandbox credentials and replaces them only with the installation token", async () => {
		const request = new Request("https://github.com/emdash-cms/emdash.git/git-receive-pack", {
			method: "POST",
			headers: { authorization: `Basic ${btoa("emdashbot:123.signature")}` },
			body: "PACK payload",
		});
		const anonymous = withGithubAuthorization(request.clone(), "github.com", null);
		const authenticated = withGithubAuthorization(
			request.clone(),
			"github.com",
			"installation-token",
		);

		expect(anonymous.headers.has("authorization")).toBe(false);
		expect(authenticated.headers.get("authorization")).toBe(
			`Basic ${btoa("x-access-token:installation-token")}`,
		);
		await expect(anonymous.text()).resolves.toBe("PACK payload");
		await expect(authenticated.text()).resolves.toBe("PACK payload");
	});

	test("round-trips only with the signing secret", async () => {
		const capability = await createPushCapability("webhook-secret", OWNER, REPO, 123);

		await expect(verifyPushCapability(capability, "webhook-secret", OWNER, REPO)).resolves.toBe(
			123,
		);
		await expect(
			verifyPushCapability(capability, "different-secret", OWNER, REPO),
		).resolves.toBeNull();
		await expect(
			verifyPushCapability(`456.${capability.split(".")[1]}`, "webhook-secret", OWNER, REPO),
		).resolves.toBeNull();
		await expect(verifyPushCapability("123.!", "webhook-secret", OWNER, REPO)).resolves.toBeNull();
	});

	test("fails closed without a secret or for another repository", async () => {
		const capability = await createPushCapability("webhook-secret", OWNER, REPO, 123);

		await expect(createPushCapability("", OWNER, REPO, 123)).rejects.toThrow(/secret/);
		await expect(verifyPushCapability(capability, "", OWNER, REPO)).resolves.toBeNull();
		await expect(
			verifyPushCapability(capability, "webhook-secret", OWNER, "another-repo"),
		).resolves.toBeNull();
	});
});

function pktLine(payload: string): string {
	return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

describe("gateGithubRequest", () => {
	test("allows public GitHub reads anonymously outside the configured repository", async () => {
		for (const url of [
			"https://github.com/WiseLibs/better-sqlite3/releases/download/v12.8.0/better-sqlite3.tar.gz",
			"https://codeload.github.com/WiseLibs/better-sqlite3/tar.gz/refs/tags/v12.8.0",
			"https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/package.json",
			"https://api.github.com/repos/WiseLibs/better-sqlite3/releases/latest",
		]) {
			const request = new Request(url);
			await expect(inspectGithubRequest(request, new URL(url), OWNER, REPO)).resolves.toMatchObject(
				{
					allowed: true,
					authentication: "anonymous",
				},
			);
		}
	});

	test("keeps configured repository reads on the installation-token path", async () => {
		const url = new URL("https://github.com/emdash-cms/emdash.git/info/refs");
		await expect(inspectGithubRequest(new Request(url), url, OWNER, REPO)).resolves.toMatchObject({
			allowed: true,
			authentication: "installation",
		});
	});

	test("still denies writes outside the configured repository", async () => {
		const url = new URL("https://api.github.com/repos/WiseLibs/better-sqlite3/issues");
		await expect(
			inspectGithubRequest(new Request(url, { method: "POST", body: "{}" }), url, OWNER, REPO),
		).resolves.toMatchObject({ allowed: false, stage: "repository" });
	});

	test("limits API reads to the configured repository", async () => {
		await expect(
			gate("https://api.github.com/repos/emdash-cms/emdash/issues/1"),
		).resolves.toBeNull();
		await expect(gate("https://api.github.com/repos/other/public/issues/1")).resolves.toBeNull();
	});

	test("denies all API writes from the agent", async () => {
		await expect(
			gate("https://api.github.com/repos/emdash-cms/emdash/issues/1", { method: "PATCH" }),
		).resolves.toMatch(/read-only/);
	});

	test("allows only the current issue's candidate and artifacts branches", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/fix-123\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toBeNull();
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/main\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/current issue/);
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/fix-456\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/current issue/);
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/artifacts-123\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toBeNull();
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/heads/bot/artifacts-456\0 report-status\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/current issue/);
	});

	test("inspects gzip-compressed receive-pack commands before allowing a push", async () => {
		const url = new URL("https://github.com/emdash-cms/emdash.git/git-receive-pack");
		const body = gzipSync(
			`${pktLine("old new refs/heads/bot/fix-123\0 report-status\n")}0000PACKpayload`,
		);
		await expect(
			inspectGithubRequest(
				new Request(url, {
					method: "POST",
					headers: { "content-encoding": "gzip" },
					body,
				}),
				url,
				OWNER,
				REPO,
				123,
			),
		).resolves.toMatchObject({
			allowed: true,
			refs: ["refs/heads/bot/fix-123"],
		});
	});

	test("allows a shallow declaration before the scoped receive-pack command", async () => {
		const url = new URL("https://github.com/emdash-cms/emdash.git/git-receive-pack");
		const shallow = pktLine(`shallow ${"a".repeat(40)}\n`);
		const update = pktLine("old new refs/heads/bot/fix-123\0 report-status\n");

		await expect(
			inspectGithubRequest(
				new Request(url, { method: "POST", body: `${shallow}${update}0000PACKpayload` }),
				url,
				OWNER,
				REPO,
				123,
			),
		).resolves.toMatchObject({
			allowed: true,
			refs: ["refs/heads/bot/fix-123"],
		});
	});

	test("distinguishes a missing capability from a rejected receive-pack body", async () => {
		const url = new URL("https://github.com/emdash-cms/emdash.git/git-receive-pack");
		const request = new Request(url, {
			method: "POST",
			body: `${pktLine("old new refs/heads/bot/fix-123\0 report-status\n")}0000`,
		});

		await expect(inspectGithubRequest(request, url, OWNER, REPO)).resolves.toMatchObject({
			allowed: false,
			stage: "capability",
		});
		await expect(inspectGithubRequest(request, url, OWNER, REPO, 456)).resolves.toMatchObject({
			allowed: false,
			stage: "receive-pack",
			refs: ["refs/heads/bot/fix-123"],
		});
	});

	test("challenges before advertising receive-pack so Git sends push credentials", async () => {
		const url = new URL(
			"https://github.com/emdash-cms/emdash.git/info/refs?service=git-receive-pack",
		);
		const request = new Request(url);

		const result = await inspectGithubRequest(request, url, OWNER, REPO);
		expect(result).toMatchObject({ allowed: false, stage: "capability" });
		if (result.allowed) throw new Error("expected the push advertisement to be denied");

		const response = githubGateDenialResponse(result);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
		expect(response.headers.get("x-emdash-proxy-stage")).toBe("capability");
		await expect(inspectGithubRequest(request, url, OWNER, REPO, 123)).resolves.toMatchObject({
			allowed: true,
		});
	});

	test("checks the command ref rather than ref-like capability text", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		await expect(
			gate(url, {
				method: "POST",
				body: `${pktLine("old new refs/meta/evil\0 refs/heads/bot/artifacts-123\n")}0000PACKpayload`,
			}),
		).resolves.toMatch(/bot branch/);
	});

	test("rejects an unbounded receive-pack command prefix", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		const oversizedPrefix = "f".repeat(64 * 1024);

		await expect(gate(url, { method: "POST", body: oversizedPrefix })).resolves.toMatch(
			/current issue/,
		);
	});

	test("stops reading receive-pack after the command flush", async () => {
		const url = "https://github.com/emdash-cms/emdash.git/git-receive-pack";
		let pullCount = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1;
				if (pullCount === 1) {
					controller.enqueue(
						new TextEncoder().encode(
							`${pktLine("old new refs/heads/bot/artifacts-123\0 report-status\n")}0000`,
						),
					);
					return;
				}
				controller.error(new Error("pack body should not be read"));
			},
		});

		await expect(
			gate(url, { method: "POST", body, duplex: "half" } as RequestInit),
		).resolves.toBeNull();
	});
});
