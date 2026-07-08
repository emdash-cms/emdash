import { describe, expect, it } from "vitest";

import {
	checkEnvCompatibility,
	findSkippedEnvConstraints,
	hostEnvFromVersions,
	isValidVersionRange,
	parseRequires,
	satisfiesRange,
} from "../src/env/index.js";

describe("isValidVersionRange", () => {
	it("accepts comparator ranges", () => {
		expect(isValidVersionRange(">=4.16")).toBe(true);
		expect(isValidVersionRange(">=4.16.0")).toBe(true);
		expect(isValidVersionRange(">4.0.0")).toBe(true);
		expect(isValidVersionRange("<=2.0.0")).toBe(true);
		expect(isValidVersionRange("<2.0.0")).toBe(true);
		expect(isValidVersionRange("=1.2.3")).toBe(true);
		expect(isValidVersionRange("1.2.3")).toBe(true);
	});

	it("accepts caret and tilde ranges", () => {
		expect(isValidVersionRange("^4.0.0")).toBe(true);
		expect(isValidVersionRange("^4.16")).toBe(true);
		expect(isValidVersionRange("~4.16.0")).toBe(true);
		expect(isValidVersionRange("~4")).toBe(true);
	});

	it("accepts wildcard and any", () => {
		expect(isValidVersionRange("*")).toBe(true);
		expect(isValidVersionRange("4.x")).toBe(true);
		expect(isValidVersionRange("4.16.x")).toBe(true);
	});

	it("accepts AND-joined comparator sets", () => {
		expect(isValidVersionRange(">=4.16.0 <5.0.0")).toBe(true);
	});

	it("accepts || union ranges", () => {
		expect(isValidVersionRange("^4.0.0 || ^5.0.0")).toBe(true);
	});

	it("accepts prerelease versions in comparators", () => {
		expect(isValidVersionRange(">=6.0.0-beta.0")).toBe(true);
	});

	it("rejects empty and garbage", () => {
		expect(isValidVersionRange("")).toBe(false);
		expect(isValidVersionRange("   ")).toBe(false);
		expect(isValidVersionRange("not-a-range")).toBe(false);
		expect(isValidVersionRange(">=")).toBe(false);
		expect(isValidVersionRange("4.16.0.0")).toBe(false);
		expect(isValidVersionRange(">>4.0.0")).toBe(false);
	});
});

describe("satisfiesRange", () => {
	it("evaluates comparator ranges", () => {
		expect(satisfiesRange("4.16.0", ">=4.16")).toBe(true);
		expect(satisfiesRange("4.16.1", ">=4.16.0")).toBe(true);
		expect(satisfiesRange("4.12.0", ">=4.16")).toBe(false);
		expect(satisfiesRange("4.16.0", ">4.16.0")).toBe(false);
		expect(satisfiesRange("4.16.1", ">4.16.0")).toBe(true);
	});

	it("evaluates caret ranges", () => {
		expect(satisfiesRange("4.16.0", "^4.0.0")).toBe(true);
		expect(satisfiesRange("4.99.0", "^4.0.0")).toBe(true);
		expect(satisfiesRange("5.0.0", "^4.0.0")).toBe(false);
		expect(satisfiesRange("3.9.0", "^4.0.0")).toBe(false);
	});

	it("evaluates tilde ranges", () => {
		expect(satisfiesRange("4.16.5", "~4.16.0")).toBe(true);
		expect(satisfiesRange("4.17.0", "~4.16.0")).toBe(false);
	});

	it("evaluates AND-joined comparator sets", () => {
		expect(satisfiesRange("4.16.0", ">=4.16.0 <5.0.0")).toBe(true);
		expect(satisfiesRange("5.0.0", ">=4.16.0 <5.0.0")).toBe(false);
	});

	it("matches the wildcard against any version", () => {
		expect(satisfiesRange("4.16.0", "*")).toBe(true);
		expect(satisfiesRange("1.0.0-rc.1", "*")).toBe(true);
	});

	it("evaluates || union ranges", () => {
		expect(satisfiesRange("5.1.0", "^4.0.0 || ^5.0.0")).toBe(true);
		expect(satisfiesRange("3.0.0", "^4.0.0 || ^5.0.0")).toBe(false);
	});

	it("evaluates a prerelease host by precedence, not excluded from release ranges", () => {
		expect(satisfiesRange("1.0.0-rc.1", ">=0.13.0")).toBe(true);
		expect(satisfiesRange("4.1.0-beta.2", "^4.0.0")).toBe(true);
	});

	it("treats an unparseable host version as satisfied (cannot prove incompatible)", () => {
		expect(satisfiesRange("dev", ">=4.16")).toBe(true);
		expect(satisfiesRange("", ">=4.16")).toBe(true);
	});

	it("treats an unparseable range as satisfied (cannot enforce garbage)", () => {
		expect(satisfiesRange("4.16.0", "not-a-range")).toBe(true);
	});
});

describe("parseRequires", () => {
	it("returns env:* and DID keys with string values", () => {
		const parsed = parseRequires({
			"env:emdash": ">=1.0.0",
			"env:astro": ">=4.16",
			"did:plc:abc123": "^1.0.0",
		});
		expect(parsed).toEqual({
			"env:emdash": ">=1.0.0",
			"env:astro": ">=4.16",
			"did:plc:abc123": "^1.0.0",
		});
	});

	it("drops non-string values", () => {
		expect(parseRequires({ "env:astro": 4 })).toEqual({});
		expect(parseRequires({ "env:astro": { foo: "bar" } })).toEqual({});
	});

	it("drops keys that are not env:* or DID-shaped", () => {
		expect(parseRequires({ astro: ">=4.16", "env:": ">=1", foo: ">=1" })).toEqual({});
	});

	it("returns an empty object for non-object input", () => {
		expect(parseRequires(undefined)).toEqual({});
		expect(parseRequires(null)).toEqual({});
		expect(parseRequires("garbage")).toEqual({});
		expect(parseRequires(42)).toEqual({});
		expect(parseRequires([])).toEqual({});
	});
});

describe("checkEnvCompatibility", () => {
	it("returns no mismatches when every constraint is satisfied", () => {
		const result = checkEnvCompatibility(
			{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" },
			{ "env:emdash": "1.2.0", "env:astro": "4.16.0" },
		);
		expect(result).toEqual([]);
	});

	it("reports the env keys whose host version does not satisfy the range", () => {
		const result = checkEnvCompatibility(
			{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" },
			{ "env:emdash": "1.2.0", "env:astro": "4.12.0" },
		);
		expect(result).toEqual([{ key: "env:astro", required: ">=4.16", host: "4.12.0" }]);
	});

	it("skips env keys the host does not advertise (no known version)", () => {
		const result = checkEnvCompatibility(
			{ "did:plc:abc": "^1.0.0" },
			{ "env:emdash": "1.2.0", "env:astro": "4.16.0" },
		);
		expect(result).toEqual([]);
	});

	it("guards unknown requires shapes without crashing", () => {
		expect(checkEnvCompatibility(undefined, { "env:emdash": "1.2.0" })).toEqual([]);
		expect(checkEnvCompatibility("garbage", { "env:emdash": "1.2.0" })).toEqual([]);
		expect(checkEnvCompatibility({ "env:astro": 999 }, { "env:astro": "4.16.0" })).toEqual([]);
	});

	it("skips host envs whose version is unknown/unparseable", () => {
		const result = checkEnvCompatibility({ "env:emdash": ">=1.0.0" }, { "env:emdash": "dev" });
		expect(result).toEqual([]);
	});
});

describe("findSkippedEnvConstraints", () => {
	it("returns nothing when every env constraint is evaluable", () => {
		expect(
			findSkippedEnvConstraints(
				{ "env:emdash": ">=1.0.0", "env:astro": ">=4.0.0" },
				{ "env:emdash": "1.2.0", "env:astro": "4.16.0" },
			),
		).toEqual([]);
	});

	it("flags an env the host does not advertise as unknown", () => {
		expect(findSkippedEnvConstraints({ "env:astro": ">=4.16" }, { "env:emdash": "1.2.0" })).toEqual(
			[{ key: "env:astro", required: ">=4.16", reason: "unknown" }],
		);
	});

	it("flags an env whose host version is not parseable semver", () => {
		expect(findSkippedEnvConstraints({ "env:emdash": ">=1.0.0" }, { "env:emdash": "dev" })).toEqual(
			[{ key: "env:emdash", required: ">=1.0.0", reason: "unparseable" }],
		);
	});

	it("ignores DID-keyed constraints (package deps, not host envs)", () => {
		expect(findSkippedEnvConstraints({ "did:plc:abc": "^1.0.0" }, {})).toEqual([]);
	});

	it("does not crash on a garbage requires shape", () => {
		expect(findSkippedEnvConstraints("garbage", {})).toEqual([]);
		expect(findSkippedEnvConstraints(null, {})).toEqual([]);
	});
});

describe("hostEnvFromVersions", () => {
	it("maps emdash + astro versions to env:* keys", () => {
		expect(hostEnvFromVersions("1.2.0", "4.16.0")).toEqual({
			"env:emdash": "1.2.0",
			"env:astro": "4.16.0",
		});
	});

	it("omits a dev emdash build so the gate skips it", () => {
		expect(hostEnvFromVersions("dev", "4.16.0")).toEqual({ "env:astro": "4.16.0" });
	});

	it("omits each env whose version is unknown", () => {
		expect(hostEnvFromVersions("1.2.0", undefined)).toEqual({ "env:emdash": "1.2.0" });
		expect(hostEnvFromVersions(undefined, "4.16.0")).toEqual({ "env:astro": "4.16.0" });
		expect(hostEnvFromVersions(undefined, undefined)).toEqual({});
	});
});
