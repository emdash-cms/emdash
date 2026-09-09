import type { ActorResolver } from "@atcute/identity-resolver";
import type { DirectPdsDidDocumentResolver } from "@emdash-cms/registry-client/direct-pds";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	findAuthoritativeRelease,
	findProofVerifiedRelease,
	PublisherSnapshotError,
	readPublisherVerificationSnapshot,
	samePdsOrigin,
} from "../src/verification/pds.js";

const PUBLISHER_DID = "did:plc:publisher";
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIguIOtOxeeD6PfhhwV1Tbcy0g1a5TRE+tSQA0QlhEj6FRndmVyc2lvbgHQAQFxEiC4g607F54Po9+GHBXVNtzLSDVrlNET61JADRCWESPoVKZjZGlkcWRpZDpwbGM6cHVibGlzaGVyY3Jldm0zbXVqa3M1bG53azI0Y3NpZ1hA4lFxxn7YC9lg4/mEb9l7Lb+uN+8EzZvH6XsUrpCbtNg+kr0+VIQArQba1jZajQL4pc1IeP6Oq1KRWPcVGKZpTGRkYXRh2CpYJQABcRIg5rQ4qhRh79SdMF1zLkkklmnQjgkMGK7mrU2HiQJnRYtkcHJldvZndmVyc2lvbgOXAgFxEiDmtDiqFGHv1J0wXXMuSSSWadCOCQwYruatTYeJAmdFi6JhZYOkYWtYMmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5YXAAYXT2YXbYKlglAAFxEiCbCJ4mzguVrq3pAScroVTnqCHzCv4UparTIJIiZW7sXqRha1VyZWxlYXNlL2dhbGxlcnk6MS4wLjBhcBgjYXT2YXbYKlglAAFxEiAVgbNAcHSSrRFFo3roii2+pXMBVGSC2AOYbrJfAzWLwqRha0M3LjBhcBg1YXT2YXbYKlglAAFxEiBhFDeoEsxJobozp3Y26kHUHywaIc1posb8QrJvJtD0DWFs9roEAXESIJsInibOC5WurekBJyuhVOeoIfMK/hSlqtMgkiJlbuxep2JpZHhJYXQ6Ly9kaWQ6cGxjOnB1Ymxpc2hlci9jb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWR0eXBlbWVtZGFzaC1wbHVnaW5lJHR5cGV4KmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZWdhdXRob3JzgaFkbmFtZWlQdWJsaXNoZXJnbGljZW5zZWNNSVRoc2VjdXJpdHmBoWVlbWFpbHRzZWN1cml0eUBleGFtcGxlLmNvbWpleHRlbnNpb25zoXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uo2UkdHlwZXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uanJlcG9zaXRvcnl4JWh0dHBzOi8vZ2l0aHViLmNvbS9lbWRhc2gtY21zL2dhbGxlcnltcmVsZWFzZVBvbGljeaNlJHR5cGV4QWNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbiNyZWxlYXNlUG9saWN5aWFwcHJvdmVyc4FwZGlkOnBsYzphcHByb3Zlcmxjb25maXJtYXRpb25mYWx3YXlz";
const REPOSITORY_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIguIOtOxeeD6PfhhwV1Tbcy0g1a5TRE+tSQA0QlhEj6FRndmVyc2lvbgHQAQFxEiC4g607F54Po9+GHBXVNtzLSDVrlNET61JADRCWESPoVKZjZGlkcWRpZDpwbGM6cHVibGlzaGVyY3Jldm0zbXVqa3M1bG53azI0Y3NpZ1hA4lFxxn7YC9lg4/mEb9l7Lb+uN+8EzZvH6XsUrpCbtNg+kr0+VIQArQba1jZajQL4pc1IeP6Oq1KRWPcVGKZpTGRkYXRh2CpYJQABcRIg5rQ4qhRh79SdMF1zLkkklmnQjgkMGK7mrU2HiQJnRYtkcHJldvZndmVyc2lvbgOXAgFxEiDmtDiqFGHv1J0wXXMuSSSWadCOCQwYruatTYeJAmdFi6JhZYOkYWtYMmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5YXAAYXT2YXbYKlglAAFxEiCbCJ4mzguVrq3pAScroVTnqCHzCv4UparTIJIiZW7sXqRha1VyZWxlYXNlL2dhbGxlcnk6MS4wLjBhcBgjYXT2YXbYKlglAAFxEiAVgbNAcHSSrRFFo3roii2+pXMBVGSC2AOYbrJfAzWLwqRha0M3LjBhcBg1YXT2YXbYKlglAAFxEiBhFDeoEsxJobozp3Y26kHUHywaIc1posb8QrJvJtD0DWFs9roEAXESIJsInibOC5WurekBJyuhVOeoIfMK/hSlqtMgkiJlbuxep2JpZHhJYXQ6Ly9kaWQ6cGxjOnB1Ymxpc2hlci9jb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWR0eXBlbWVtZGFzaC1wbHVnaW5lJHR5cGV4KmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZWdhdXRob3JzgaFkbmFtZWlQdWJsaXNoZXJnbGljZW5zZWNNSVRoc2VjdXJpdHmBoWVlbWFpbHRzZWN1cml0eUBleGFtcGxlLmNvbWpleHRlbnNpb25zoXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uo2UkdHlwZXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uanJlcG9zaXRvcnl4JWh0dHBzOi8vZ2l0aHViLmNvbS9lbWRhc2gtY21zL2dhbGxlcnltcmVsZWFzZVBvbGljeaNlJHR5cGV4QWNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbiNyZWxlYXNlUG9saWN5aWFwcHJvdmVyc4FwZGlkOnBsYzphcHByb3Zlcmxjb25maXJtYXRpb25mYWx3YXlz9AIBcRIgFYGzQHB0kq0RRaN66IotvqVzAVRkgtgDmG6yXwM1i8KlZSR0eXBleCpjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnJlbGVhc2VncGFja2FnZWdnYWxsZXJ5Z3ZlcnNpb25lMS4wLjBpYXJ0aWZhY3RzoWdwYWNrYWdlo2N1cmx4JWh0dHBzOi8vZXhhbXBsZS5jb20vZ2FsbGVyeS0xLjAuMC50Z3poY2hlY2tzdW1sYmNpcWJhc2VsaW5la2NvbnRlbnRUeXBlcGFwcGxpY2F0aW9uL2d6aXBqZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZUV4dGVuc2lvbqJlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZUV4dGVuc2lvbm5kZWNsYXJlZEFjY2Vzc6D0AgFxEiBhFDeoEsxJobozp3Y26kHUHywaIc1posb8QrJvJtD0DaVlJHR5cGV4KmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZWdwYWNrYWdlZ2dhbGxlcnlndmVyc2lvbmUxLjcuMGlhcnRpZmFjdHOhZ3BhY2thZ2WjY3VybHglaHR0cHM6Ly9leGFtcGxlLmNvbS9nYWxsZXJ5LTEuNy4wLnRnemhjaGVja3N1bWxiY2lxYmFzZWxpbmVrY29udGVudFR5cGVwYXBwbGljYXRpb24vZ3ppcGpleHRlbnNpb25zoXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5yZWxlYXNlRXh0ZW5zaW9uomUkdHlwZXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5yZWxlYXNlRXh0ZW5zaW9ubmRlY2xhcmVkQWNjZXNzoA==";
const REPOSITORY_PROOF_WITH_PROPOSED =
	"OqJlcm9vdHOB2CpYJQABcRIg8sm4dQ9lByY0xr1kL6Hz48iIe3d/hw0lf4YPySo/r0dndmVyc2lvbgHQAQFxEiDyybh1D2UHJjTGvWQvofPjyIh7d3+HDSV/hg/JKj+vR6ZjZGlkcWRpZDpwbGM6cHVibGlzaGVyY3Jldm0zbXVqa3M1bHpuazI0Y3NpZ1hAqvylIr2sgAbW1YV1lZx5mgzHMoHuezih4wfgUmZXQd4cjK/tgZd0k2Q7L07vOjDkgA7kZzlAH0xY3ysgwzyOqGRkYXRh2CpYJQABcRIgUvcaAAneyG9fVRU7P+iIJb3CImXjuRhE0PZzpiX1IpdkcHJldvZndmVyc2lvbgPSAgFxEiBS9xoACd7Ib19VFTs/6IglvcIiZeO5GETQ9nOmJfUil6JhZYSkYWtYMmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5YXAAYXT2YXbYKlglAAFxEiCbCJ4mzguVrq3pAScroVTnqCHzCv4UparTIJIiZW7sXqRha1VyZWxlYXNlL2dhbGxlcnk6MS4wLjBhcBgjYXT2YXbYKlglAAFxEiAVgbNAcHSSrRFFo3roii2+pXMBVGSC2AOYbrJfAzWLwqRha0M3LjBhcBg1YXT2YXbYKlglAAFxEiBhFDeoEsxJobozp3Y26kHUHywaIc1posb8QrJvJtD0DaRha0UyLjAuMGFwGDNhdPZhdtgqWCUAAXESIC6WNHToQDAXjf7Q4VgGmVl1AQkDEDZxj8LbF1g+SMPsYWz2ugQBcRIgmwieJs4Lla6t6QEnK6FU56gh8wr+FKWq0yCSImVu7F6nYmlkeElhdDovL2RpZDpwbGM6cHVibGlzaGVyL2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5ZHR5cGVtZW1kYXNoLXBsdWdpbmUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlZ2F1dGhvcnOBoWRuYW1laVB1Ymxpc2hlcmdsaWNlbnNlY01JVGhzZWN1cml0eYGhZWVtYWlsdHNlY3VyaXR5QGV4YW1wbGUuY29tamV4dGVuc2lvbnOheDNjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGVFeHRlbnNpb26jZSR0eXBleDNjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGVFeHRlbnNpb25qcmVwb3NpdG9yeXglaHR0cHM6Ly9naXRodWIuY29tL2VtZGFzaC1jbXMvZ2FsbGVyeW1yZWxlYXNlUG9saWN5o2UkdHlwZXhBY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uI3JlbGVhc2VQb2xpY3lpYXBwcm92ZXJzgXBkaWQ6cGxjOmFwcHJvdmVybGNvbmZpcm1hdGlvbmZhbHdheXP0AgFxEiAVgbNAcHSSrRFFo3roii2+pXMBVGSC2AOYbrJfAzWLwqVlJHR5cGV4KmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZWdwYWNrYWdlZ2dhbGxlcnlndmVyc2lvbmUxLjAuMGlhcnRpZmFjdHOhZ3BhY2thZ2WjY3VybHglaHR0cHM6Ly9leGFtcGxlLmNvbS9nYWxsZXJ5LTEuMC4wLnRnemhjaGVja3N1bWxiY2lxYmFzZWxpbmVrY29udGVudFR5cGVwYXBwbGljYXRpb24vZ3ppcGpleHRlbnNpb25zoXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5yZWxlYXNlRXh0ZW5zaW9uomUkdHlwZXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5yZWxlYXNlRXh0ZW5zaW9ubmRlY2xhcmVkQWNjZXNzoPQCAXESIGEUN6gSzEmhujOndjbqQdQfLBohzWmixvxCsm8m0PQNpWUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5yZWxlYXNlZ3BhY2thZ2VnZ2FsbGVyeWd2ZXJzaW9uZTEuNy4waWFydGlmYWN0c6FncGFja2FnZaNjdXJseCVodHRwczovL2V4YW1wbGUuY29tL2dhbGxlcnktMS43LjAudGd6aGNoZWNrc3VtbGJjaXFiYXNlbGluZWtjb250ZW50VHlwZXBhcHBsaWNhdGlvbi9nemlwamV4dGVuc2lvbnOheDNjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnJlbGVhc2VFeHRlbnNpb26iZSR0eXBleDNjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnJlbGVhc2VFeHRlbnNpb25uZGVjbGFyZWRBY2Nlc3Og9AIBcRIgLpY0dOhAMBeN/tDhWAaZWXUBCQMQNnGPwtsXWD5Iw+ylZSR0eXBleCpjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnJlbGVhc2VncGFja2FnZWdnYWxsZXJ5Z3ZlcnNpb25lMi4wLjBpYXJ0aWZhY3RzoWdwYWNrYWdlo2N1cmx4JWh0dHBzOi8vZXhhbXBsZS5jb20vZ2FsbGVyeS0yLjAuMC50Z3poY2hlY2tzdW1sYmNpcXByb3Bvc2Vka2NvbnRlbnRUeXBlcGFwcGxpY2F0aW9uL2d6aXBqZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZUV4dGVuc2lvbqJlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucmVsZWFzZUV4dGVuc2lvbm5kZWNsYXJlZEFjY2Vzc6A=";

function resolver(): ActorResolver {
	return {
		resolve: async () => ({
			did: PUBLISHER_DID,
			handle: "publisher.example.com",
			pds: "https://pds.example.com",
		}),
	};
}

function proofResolver(): DirectPdsDidDocumentResolver {
	return {
		resolve: () =>
			Promise.resolve({
				id: PUBLISHER_DID,
				alsoKnownAs: ["at://publisher.example.com"],
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: "zDnaejExR13CZ7p99ojitvboj6ZaYzxhMDqJwnZd7APbohKkR",
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			}),
	};
}

function profileProofResponse(tampered = false): Response {
	const bytes = Uint8Array.from(atob(PROFILE_PROOF), (character) => character.charCodeAt(0));
	if (tampered) bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
	return new Response(bytes, { headers: { "content-type": "application/vnd.ipld.car" } });
}

function repositoryProofResponse(encoded = REPOSITORY_PROOF, tampered = false): Response {
	const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
	if (tampered) bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
	return new Response(bytes, { headers: { "content-type": "application/vnd.ipld.car" } });
}

function release(version: string, packageSlug = "gallery") {
	return {
		uri: `at://${PUBLISHER_DID}/${NSID.packageRelease}/${packageSlug}:${version}`,
		cid: `bafy${packageSlug}${version.replaceAll(".", "")}`,
		value: { package: packageSlug, version },
	};
}

function snapshotFetch(
	options: {
		privateAddress?: boolean;
		proposedExists?: boolean;
		repositoryContentLength?: number;
		repositoryNotFound?: boolean;
		tamperedProfile?: boolean;
	} = {},
) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer:
					url.searchParams.get("type") === "A"
						? [{ type: 1, data: options.privateAddress ? "10.0.0.1" : "93.184.216.34" }]
						: [],
			});
		}
		if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			return profileProofResponse(options.tamperedProfile);
		}
		if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
			if (options.repositoryNotFound) {
				return Response.json({ error: "RepoNotFound" }, { status: 404 });
			}
			const response = repositoryProofResponse(
				options.proposedExists ? REPOSITORY_PROOF_WITH_PROPOSED : REPOSITORY_PROOF,
				options.tamperedProfile,
			);
			if (options.repositoryContentLength === undefined) return response;
			const headers = new Headers(response.headers);
			headers.set("content-length", String(options.repositoryContentLength));
			return new Response(response.body, { headers });
		}
		if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
			expect(url.searchParams.has("rkeyStart")).toBe(false);
			expect(url.searchParams.has("rkeyEnd")).toBe(false);
			if (url.searchParams.get("cursor") === null) {
				return Response.json({
					records: [release("9.0.0", "other"), release("1.9.0"), release("1.10.0")],
					cursor: "page-2",
				});
			}
			return Response.json({
				records: [
					release("not-semver", "unrelated"),
					release("2.0.0-rc.1"),
					...(options.proposedExists ? [release("2.0.0")] : []),
				],
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

function releaseFetch(record: ReturnType<typeof release> | null, options: { error?: string } = {}) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
			});
		}
		expect(url.pathname).toBe("/xrpc/com.atproto.repo.getRecord");
		expect(url.searchParams.get("repo")).toBe(PUBLISHER_DID);
		expect(url.searchParams.get("collection")).toBe(NSID.packageRelease);
		expect(url.searchParams.get("rkey")).toBe("gallery:2.0.0");
		return record
			? Response.json(record)
			: Response.json({ error: options.error ?? "RecordNotFound" }, { status: 400 });
	};
}

describe("PDS origin identity", () => {
	it("treats canonical URL variants as the same resource server", () => {
		expect(samePdsOrigin("https://pds.example.com", "https://PDS.EXAMPLE.COM:443/")).toBe(true);
		expect(samePdsOrigin("https://pds.example.com", "https://pds.example.com:8443/")).toBe(false);
	});
});

describe("publisher verification snapshot", () => {
	it("uses a signed repository proof instead of an unverified profile response", async () => {
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
				return Response.json({
					uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
					cid: "bafyunverified",
					value: {
						$type: NSID.packageProfile,
						id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
						license: "unverified",
					},
				});
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
				return profileProofResponse();
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
				return repositoryProofResponse();
			}
			if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
				return Response.json({ records: [release("1.0.0")] });
			}
			throw new Error(`Unexpected request: ${url.toString()} ${String(init?.method)}`);
		};

		const snapshot = await readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
			actorResolver: resolver(),
			didDocumentResolver: proofResolver(),
			fetch,
		});

		expect(snapshot.profile).toMatchObject({ value: { license: "MIT" } });
	});

	it("reads the authoritative profile, proves absence, and selects the highest signed baseline", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch(),
			}),
		).resolves.toMatchObject({
			profile: { cid: expect.stringMatching(/^b/) },
			proposedRkey: "gallery:2.0.0",
			proposedReleaseAbsent: true,
			baselineVersion: "1.7.0",
			baseline: { cid: expect.stringMatching(/^b/) },
		});
	});

	it("fails when the deterministic release key already exists", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ proposedExists: true }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_EXISTS" });
	});

	it("rejects a profile whose repository proof is invalid", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ tamperedProfile: true }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_LIST_INVALID" });
	});

	it("rejects private PDS resolution before record egress", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ privateAddress: true }),
			}),
		).rejects.toBeInstanceOf(PublisherSnapshotError);
	});

	it("accepts a repository export above the single-record response budget", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ repositoryContentLength: 600 * 1024 }),
			}),
		).resolves.toMatchObject({ baselineVersion: "1.7.0" });
	});

	it("maps a restored sync.getRepo 404 to an invalid publisher identity", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				didDocumentResolver: proofResolver(),
				fetch: snapshotFetch({ repositoryNotFound: true }),
			}),
		).rejects.toMatchObject({ code: "PUBLISHER_IDENTITY_INVALID" });
	});

	it("ignores an unsigned higher-semver baseline injected into listRecords", async () => {
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
				return Response.json({ records: [release("99.0.0")] });
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRecord") return profileProofResponse();
			if (url.pathname === "/xrpc/com.atproto.sync.getRepo") return repositoryProofResponse();
			throw new Error(`Unexpected request: ${url.toString()} ${String(init?.method)}`);
		};

		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch,
			}),
		).resolves.toMatchObject({ baselineVersion: "1.7.0" });
	});

	it("retains a genuine baseline omitted from listRecords", async () => {
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
				return Response.json({ records: [] });
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRecord") return profileProofResponse();
			if (url.pathname === "/xrpc/com.atproto.sync.getRepo") return repositoryProofResponse();
			throw new Error(`Unexpected request: ${url.toString()} ${String(init?.method)}`);
		};

		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch,
			}),
		).resolves.toMatchObject({ baselineVersion: "1.7.0" });
	});
});

describe("authoritative release reconciliation read", () => {
	it("reads only the deterministic release key and returns its authoritative CID", async () => {
		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(release("2.0.0")),
			}),
		).resolves.toEqual(release("2.0.0"));
	});

	it("accepts only the explicit RecordNotFound response as confirmed absence", async () => {
		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(null),
			}),
		).resolves.toBeNull();

		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(null, { error: "InvalidRequest" }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_RECORD_INVALID" });
	});

	it("preserves sync.getRecord 404 status through the guarded fetch", async () => {
		const fetch: typeof globalThis.fetch = async (input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
			}
			if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
				return Response.json(release("2.0.0"));
			}
			if (url.pathname === "/xrpc/com.atproto.sync.getRecord") {
				return Response.json({ error: "RecordNotFound" }, { status: 404 });
			}
			throw new Error(`Unexpected request: ${url.toString()}`);
		};

		await expect(
			findProofVerifiedRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				didDocumentResolver: proofResolver(),
				fetch,
			}),
		).resolves.toBeNull();
	});
});
