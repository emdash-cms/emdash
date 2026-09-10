import { DirectPdsClient } from "@emdash-cms/registry-client/direct-pds";
import { expect, it } from "vitest";

it("loads the direct PDS repository verifier in workerd", () => {
	expect(() => new DirectPdsClient({ did: "invalid", fetch })).toThrow(
		"did must be a valid did:plc or did:web identifier",
	);
});
