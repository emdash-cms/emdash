import { expectTypeOf, it } from "vitest";

import type {
	EmailAfterSendEvent,
	EmailBeforeSendEvent,
	EmailDeliverEvent,
	EmailDeliverHandler,
	EmailMessage,
	PluginContext,
} from "../../../src/index.js";

it("exports the email hook types a transport plugin implements", () => {
	const deliver: EmailDeliverHandler = async (event, ctx) => {
		expectTypeOf(event).toEqualTypeOf<EmailDeliverEvent>();
		expectTypeOf(event.message).toEqualTypeOf<EmailMessage>();
		expectTypeOf(ctx).toEqualTypeOf<PluginContext>();
	};
	expectTypeOf(deliver).returns.resolves.toBeVoid();
	expectTypeOf<EmailBeforeSendEvent["message"]>().toEqualTypeOf<EmailMessage>();
	expectTypeOf<EmailAfterSendEvent["message"]>().toEqualTypeOf<EmailMessage>();
});
