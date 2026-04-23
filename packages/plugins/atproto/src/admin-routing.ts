export interface AdminInteraction {
	type?: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

export function getAdminPageTarget(interaction?: AdminInteraction): "status" | "sync-widget" | null {
	const interactionType = interaction?.type ?? "page_load";
	const page = interaction?.page ?? "/status";

	if (interactionType !== "page_load") return null;
	if (page === "widget:sync-status") return "sync-widget";
	if (page === "/" || page === "/status" || page === "/settings") return "status";
	return null;
}
