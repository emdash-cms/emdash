import { describe, expect, it } from "vitest";

import { creationOptions, requestOptions } from "./webauthn.js";

function bytes(value: BufferSource): number[] {
	return value instanceof ArrayBuffer
		? [...new Uint8Array(value)]
		: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
}

describe("passkey option decoding", () => {
	it("decodes required-UV registration options", () => {
		const options = creationOptions({
			challenge: "AQID",
			rp: { id: "release.example.com", name: "EmDash" },
			user: { id: "BAUG", name: "did:plc:approver", displayName: "Approver" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }],
			authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
			excludeCredentials: [{ type: "public-key", id: "BwgJ", transports: ["internal"] }],
		});

		expect(bytes(options.challenge)).toEqual([1, 2, 3]);
		expect(bytes(options.user.id)).toEqual([4, 5, 6]);
		expect(options.authenticatorSelection?.userVerification).toBe("required");
		expect(options.excludeCredentials?.[0]?.transports).toEqual(["internal"]);
	});

	it("decodes required-UV approval options and rejects malformed challenges", () => {
		const options = requestOptions({
			challenge: "AQID",
			rpId: "release.example.com",
			userVerification: "required",
			allowCredentials: [{ type: "public-key", id: "BwgJ" }],
		});
		expect(bytes(options.challenge)).toEqual([1, 2, 3]);
		expect(options.userVerification).toBe("required");
		expect(() => requestOptions({ challenge: "not base64!" })).toThrow("Invalid passkey options");
	});
});
