import { describe, expect, it } from "vitest";

import {
	InvalidAcceptLabelersHeaderError,
	parseAcceptLabelersHeader,
	serializeContentLabelersHeader,
	type AcceptedLabelerPolicy,
} from "../src/index.js";

const alice = "did:example:alice";
const bob = "did:example:bob";

describe("parseAcceptLabelersHeader", () => {
	it("treats an empty or whitespace-only value as no accepted labelers", () => {
		expect(parseAcceptLabelersHeader("")).toEqual([]);
		expect(parseAcceptLabelersHeader("   ")).toEqual([]);
		expect(parseAcceptLabelersHeader("\t \t")).toEqual([]);
	});

	it("parses a single DID with no parameters", () => {
		expect(parseAcceptLabelersHeader(alice)).toEqual([{ did: alice, redact: false }]);
	});

	it("parses a single DID with a bare redact parameter", () => {
		expect(parseAcceptLabelersHeader(`${alice};redact`)).toEqual([{ did: alice, redact: true }]);
	});

	it("parses redact=?1 as true", () => {
		expect(parseAcceptLabelersHeader(`${alice};redact=?1`)).toEqual([{ did: alice, redact: true }]);
	});

	it("parses redact=?0 as false but keeps the entry", () => {
		expect(parseAcceptLabelersHeader(`${alice};redact=?0`)).toEqual([
			{ did: alice, redact: false },
		]);
	});

	it("parses multiple DIDs preserving order", () => {
		expect(parseAcceptLabelersHeader(`${bob}, ${alice}`)).toEqual([
			{ did: bob, redact: false },
			{ did: alice, redact: false },
		]);
	});

	describe("duplicate DID redact merge", () => {
		it("plain then redact merges to true", () => {
			expect(parseAcceptLabelersHeader(`${alice}, ${alice};redact`)).toEqual([
				{ did: alice, redact: true },
			]);
		});

		it("redact then plain merges to true", () => {
			expect(parseAcceptLabelersHeader(`${alice};redact, ${alice}`)).toEqual([
				{ did: alice, redact: true },
			]);
		});

		it("redact then explicit ?0 does not un-set true", () => {
			expect(parseAcceptLabelersHeader(`${alice};redact, ${alice};redact=?0`)).toEqual([
				{ did: alice, redact: true },
			]);
		});

		it("?0 then ?0 stays false", () => {
			expect(parseAcceptLabelersHeader(`${alice};redact=?0, ${alice};redact=?0`)).toEqual([
				{ did: alice, redact: false },
			]);
		});

		it("preserves first-occurrence order across a run of duplicates", () => {
			expect(parseAcceptLabelersHeader(`${bob}, ${alice}, ${bob};redact`)).toEqual([
				{ did: bob, redact: true },
				{ did: alice, redact: false },
			]);
		});
	});

	describe("OWS tolerance", () => {
		it("allows spaces around the list-separating comma", () => {
			expect(parseAcceptLabelersHeader(`${alice} , ${bob}`)).toEqual([
				{ did: alice, redact: false },
				{ did: bob, redact: false },
			]);
		});

		it("allows tabs around the list-separating comma", () => {
			expect(parseAcceptLabelersHeader(`${alice}\t,\t${bob}`)).toEqual([
				{ did: alice, redact: false },
				{ did: bob, redact: false },
			]);
		});

		it("allows a space between ';' and the parameter key", () => {
			expect(parseAcceptLabelersHeader(`${alice}; redact`)).toEqual([{ did: alice, redact: true }]);
		});

		it("rejects a tab between ';' and the parameter key", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};\tredact`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects whitespace before ';' since parameters must directly follow the item", () => {
			expect(() => parseAcceptLabelersHeader(`${alice} ;redact`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("tolerates leading and trailing OWS around the whole header value", () => {
			expect(parseAcceptLabelersHeader(`  ${alice}  `)).toEqual([{ did: alice, redact: false }]);
		});
	});

	describe("unknown parameters are ignored", () => {
		it("ignores a bare unknown key", () => {
			expect(parseAcceptLabelersHeader(`${alice};foo`)).toEqual([{ did: alice, redact: false }]);
		});

		it("ignores an unknown key with a boolean value", () => {
			expect(parseAcceptLabelersHeader(`${alice};foo=?0`)).toEqual([{ did: alice, redact: false }]);
		});

		it("ignores an unknown key with a token value", () => {
			expect(parseAcceptLabelersHeader(`${alice};foo=bar`)).toEqual([
				{ did: alice, redact: false },
			]);
		});

		it("ignores an unknown key with a quoted string value, including escapes", () => {
			expect(parseAcceptLabelersHeader(`${alice};foo="quoted \\" string"`)).toEqual([
				{ did: alice, redact: false },
			]);
		});

		it("still honours redact alongside an ignored unknown parameter", () => {
			expect(parseAcceptLabelersHeader(`${alice};foo=bar;redact`)).toEqual([
				{ did: alice, redact: true },
			]);
		});
	});

	describe("invalid syntax", () => {
		it("rejects an empty list member from a leading comma", () => {
			expect(() => parseAcceptLabelersHeader(`,${alice}`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects an empty list member from a trailing comma", () => {
			expect(() => parseAcceptLabelersHeader(`${alice},`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects an empty list member between two commas", () => {
			expect(() => parseAcceptLabelersHeader(`${alice},,${bob}`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects a bare parameter with no preceding DID", () => {
			expect(() => parseAcceptLabelersHeader(";redact")).toThrow(InvalidAcceptLabelersHeaderError);
		});

		it("rejects a non-DID token", () => {
			expect(() => parseAcceptLabelersHeader("notadid")).toThrow(InvalidAcceptLabelersHeaderError);
		});

		it("rejects an uppercase DID method", () => {
			expect(() => parseAcceptLabelersHeader("did:UPPER:x")).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects a DID with an empty method-specific id", () => {
			expect(() => parseAcceptLabelersHeader("did:example:")).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects redact=1 (not an RFC 8941 boolean)", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};redact=1`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects redact as a quoted string", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};redact="true"`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects an unterminated quoted string", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};foo="unterminated`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects an invalid parameter key starting with uppercase", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};Redact`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects an invalid parameter key starting with a digit", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};9x`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});

		it("rejects a trailing ';' with no key", () => {
			expect(() => parseAcceptLabelersHeader(`${alice};`)).toThrow(
				InvalidAcceptLabelersHeaderError,
			);
		});
	});
});

describe("serializeContentLabelersHeader", () => {
	it("serializes an empty list to an empty string", () => {
		expect(serializeContentLabelersHeader([])).toBe("");
	});

	it("serializes a plain DID without a redact parameter", () => {
		expect(serializeContentLabelersHeader([{ did: alice, redact: false }])).toBe(alice);
	});

	it("serializes a redacted DID with the ;redact parameter", () => {
		expect(serializeContentLabelersHeader([{ did: alice, redact: true }])).toBe(`${alice};redact`);
	});

	it("serializes a mix of plain and redacted DIDs joined by ', '", () => {
		expect(
			serializeContentLabelersHeader([
				{ did: alice, redact: false },
				{ did: bob, redact: true },
			]),
		).toBe(`${alice}, ${bob};redact`);
	});

	it("dedupes and merges redact with union semantics before serializing", () => {
		expect(
			serializeContentLabelersHeader([
				{ did: alice, redact: false },
				{ did: alice, redact: true },
			]),
		).toBe(`${alice};redact`);
	});

	function dedupe(policies: readonly AcceptedLabelerPolicy[]): AcceptedLabelerPolicy[] {
		const order: string[] = [];
		const redactByDid = new Map<string, boolean>();
		for (const policy of policies) {
			const existing = redactByDid.get(policy.did);
			if (existing === undefined) order.push(policy.did);
			redactByDid.set(policy.did, existing === true || policy.redact);
		}
		return order.map((did) => ({ did, redact: redactByDid.get(did)! }));
	}

	describe("round-trip stability", () => {
		const cases: AcceptedLabelerPolicy[][] = [
			[],
			[{ did: alice, redact: false }],
			[{ did: alice, redact: true }],
			[
				{ did: alice, redact: false },
				{ did: bob, redact: true },
			],
			[
				{ did: bob, redact: true },
				{ did: alice, redact: false },
				{ did: bob, redact: false },
			],
		];

		for (const [index, policies] of cases.entries()) {
			it(`round-trips case ${index}`, () => {
				const serialized = serializeContentLabelersHeader(policies);
				expect(parseAcceptLabelersHeader(serialized)).toEqual(dedupe(policies));
			});
		}
	});
});
