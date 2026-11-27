import { describe, expect, it } from "vitest";

import { clientNetwork, getClientNetwork } from "../../../src/auth/rate-limit.js";

describe("clientNetwork", () => {
	it("keeps an IPv4 address whole", () => {
		expect(clientNetwork("198.51.100.7")).toBe("198.51.100.7");
	});

	it("reduces an IPv6 address to its /64", () => {
		expect(clientNetwork("2001:db8:bad:1::1")).toBe("2001:db8:bad:1::/64");
		expect(clientNetwork("2001:0DB8:0bad:0001:ffff:ffff:ffff:ffff")).toBe("2001:db8:bad:1::/64");
		expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(clientNetwork("2001:db8:bad:2::1")).toBe("2001:db8:bad:2::/64");
	});

	it("reduces an IPv6 address that embeds an IPv4 address to that address", () => {
		expect(clientNetwork("::ffff:198.51.100.7")).toBe("198.51.100.7");
		expect(clientNetwork("::ffff:c633:6407")).toBe("198.51.100.7");
	});

	it("returns anything that is not an IPv6 address unchanged", () => {
		expect(clientNetwork("1::2::3")).toBe("1::2::3");
		expect(clientNetwork("unknown")).toBe("unknown");
	});
});

describe("getClientNetwork", () => {
	function requestFrom(ip: string): Request {
		return new Request("http://localhost/test", { headers: { "x-real-ip": ip } });
	}

	it("gives every address of one IPv6 /64 the same subject", () => {
		const subjects = ["2001:db8:bad:1::1", "2001:db8:bad:1:dead:beef:0:1"].map((ip) =>
			getClientNetwork(requestFrom(ip), ["x-real-ip"]),
		);
		expect(subjects).toEqual(["2001:db8:bad:1::/64", "2001:db8:bad:1::/64"]);
	});

	it("returns null without a trusted IP", () => {
		expect(getClientNetwork(requestFrom("203.0.113.50"))).toBeNull();
	});
});
