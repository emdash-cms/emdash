import type { LabelSubscriptionDO } from "../label-subscription-do.js";
import { LABEL_SUBSCRIPTION_DO_NAME } from "./publisher.js";

export function subscribeLabels(
	namespace: DurableObjectNamespace<LabelSubscriptionDO>,
	request: Request,
): Promise<Response> {
	if (request.method !== "GET") {
		return Promise.resolve(
			Response.json(
				{ error: "MethodNotSupported", message: "subscribeLabels only supports GET" },
				{
					status: 405,
					headers: { allow: "GET", "cache-control": "no-store" },
				},
			),
		);
	}
	return namespace.getByName(LABEL_SUBSCRIPTION_DO_NAME).fetch(request);
}
