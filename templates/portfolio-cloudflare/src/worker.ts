import handler, {
	createMediaUsageQueueHandler,
	createScheduledHandler,
	type MediaUsageWakeMessage,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const resolveMediaUsageQueue = (env: Env) => env.MEDIA_USAGE_QUEUE;

export default {
	...handler,
	scheduled: createScheduledHandler({ resolveMediaUsageQueue }),
	queue: createMediaUsageQueueHandler(resolveMediaUsageQueue),
} satisfies ExportedHandler<Env, MediaUsageWakeMessage>;
