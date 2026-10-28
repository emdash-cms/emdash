import { DiscoveryClient } from "@emdash-cms/registry-client/discovery";
import { LATEST_RELEASE_TIMEOUT_MS } from "@emdash-cms/registry-loader";
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchCatalog, withLatestReleases } from "./catalog.js";
import { isRegistryRequestRejected } from "./registry.js";

const CID = `bafyrei${"a".repeat(52)}`;
const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function packageView(slug: string) {
	return {
		uri: `at://${DID}/com.emdashcms.experimental.package.profile/${slug}`,
		cid: CID,
		did: DID,
		handle: "alice.example.com",
		slug,
		indexedAt: "2026-09-01T12:00:00Z",
		latestVersion: "1.0.0",
		profile: {
			$type: "com.emdashcms.experimental.package.profile",
			id: `at://${DID}/com.emdashcms.experimental.package.profile/${slug}`,
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Alice" }],
			security: [{ email: "security@example.com" }],
		},
	};
}

function releaseView(slug: string) {
	return {
		uri: `at://${DID}/com.emdashcms.experimental.package.release/${slug}:1.0.0`,
		cid: CID,
		did: DID,
		package: slug,
		version: "1.0.0",
		artifactCaches: [],
		indexedAt: "2026-09-01T12:00:00Z",
		release: {
			$type: "com.emdashcms.experimental.package.release",
			package: slug,
			version: "1.0.0",
			artifacts: {
				package: { checksum: `bciq${"a".repeat(52)}`, url: `https://example.com/${slug}.tgz` },
			},
		},
	};
}

function registryAnswering(respond: (url: URL) => Response | Promise<Response>) {
	const fetch = vi.fn(async (input: RequestInfo | URL) =>
		respond(new URL(typeof input === "string" || input instanceof URL ? input : input.url)),
	);
	return { client: new DiscoveryClient({ aggregatorUrl: "https://registry.test", fetch }), fetch };
}

/** Package views as the client hands them over, after validating them. */
async function validated(...views: unknown[]) {
	const { client } = registryAnswering(() => Response.json({ packages: views }));
	return (await client.searchPackages({})).packages;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("searchCatalog", () => {
	it("follows the registry's cursor to the last page", async () => {
		const { client, fetch } = registryAnswering((url) =>
			url.searchParams.get("cursor") === "page-2"
				? Response.json({ packages: [packageView("gamma")] })
				: Response.json({
						packages: [packageView("alpha"), packageView("beta")],
						cursor: "page-2",
					}),
		);

		const result = await searchCatalog("forms", client);

		expect(result).toMatchObject({
			packages: [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }],
		});
		const requests = fetch.mock.calls.map(([input]) => new URL(input as string).searchParams);
		expect(requests.map((params) => params.get("q"))).toEqual(["forms", "forms"]);
		expect(requests.map((params) => params.get("limit"))).toEqual(["100", "100"]);
		expect(requests.map((params) => params.get("cursor"))).toEqual([null, "page-2"]);
	});

	it("lists a plugin once when a publish mid-walk shifts it onto the next page", async () => {
		const { client } = registryAnswering((url) =>
			url.searchParams.get("cursor") === "page-2"
				? Response.json({ packages: [packageView("beta"), packageView("gamma")] })
				: Response.json({
						packages: [packageView("alpha"), packageView("beta")],
						cursor: "page-2",
					}),
		);

		const result = await searchCatalog("", client);

		expect("packages" in result && result.packages.map((pkg) => pkg.slug)).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("fails instead of returning part of a catalog with more pages than it walks", async () => {
		let page = 0;
		const { client } = registryAnswering(() =>
			Response.json({ packages: [packageView(`plugin-${page}`)], cursor: `page-${++page}` }),
		);

		expect(await searchCatalog("", client)).toEqual({ error: expect.any(Error) });
	});

	it("treats only a first request the registry rejects as a rejected search", async () => {
		const answering = (status: number) =>
			registryAnswering(() => Response.json({ error: "Example", message: "Example" }, { status }))
				.client;
		const rejectingPage2 = registryAnswering((url) =>
			url.searchParams.has("cursor")
				? Response.json({ error: "InvalidRequest", message: "Invalid cursor" }, { status: 400 })
				: Response.json({ packages: [packageView("alpha")], cursor: "page-2" }),
		).client;
		const errorOf = async (client: DiscoveryClient) => {
			const result = await searchCatalog("forms", client);
			expect(result).toHaveProperty("error");
			return "error" in result ? result.error : undefined;
		};

		expect(isRegistryRequestRejected(await errorOf(answering(400)))).toBe(true);
		expect(isRegistryRequestRejected(await errorOf(answering(502)))).toBe(false);
		expect(isRegistryRequestRejected(await errorOf(rejectingPage2))).toBe(false);
	});
});

describe("withLatestReleases", () => {
	it("adds each latest release and keeps plugins whose release is missing", async () => {
		const { client, fetch } = registryAnswering((url) =>
			url.searchParams.get("package") === "alpha"
				? Response.json(releaseView("alpha"))
				: Response.json({ error: "NotFound", message: "No release" }, { status: 404 }),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const packages = await validated(packageView("alpha"), packageView("beta"), {
			...packageView("draft"),
			latestVersion: undefined,
		});

		const entries = await withLatestReleases(packages, client);

		expect(entries.map((entry) => [entry.package.slug, entry.latestRelease?.version])).toEqual([
			["alpha", "1.0.0"],
			["beta", undefined],
			["draft", undefined],
		]);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled();
	});

	it("stops waiting for a slow release after the registry loader's timeout", async () => {
		vi.useFakeTimers();
		const { client } = registryAnswering(
			() =>
				new Promise<Response>((_resolve, reject) => {
					setTimeout(() => reject(new Error("late failure")), LATEST_RELEASE_TIMEOUT_MS + 1000);
				}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const packages = await validated(packageView("alpha"));

		const pending = withLatestReleases(packages, client);
		await vi.advanceTimersByTimeAsync(LATEST_RELEASE_TIMEOUT_MS);
		const entries = await pending;
		await vi.advanceTimersByTimeAsync(1000);

		expect(entries).toEqual([{ package: packages[0] }]);
		expect(warn).toHaveBeenCalledOnce();
	});
});
