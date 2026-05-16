/**
 * Register Discord slash commands for the bot.
 *
 * Usage:
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/register-commands.mjs
 *
 * Set DISCORD_GUILD_ID for guild-scoped (instant) registration.
 * Omit it for global registration (propagates in ~1 hour).
 */

const appId = process.env.DISCORD_APP_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
console.log(
	`Registering commands for app ${appId} in ${guildId ? `guild ${guildId}` : "global scope"}...`,
);
if (!appId || !botToken) {
	console.error("DISCORD_APP_ID and DISCORD_BOT_TOKEN are required");
	process.exit(1);
}

const commands = [
	{
		name: "link",
		description:
			"Link your GitHub account to receive the Contributor role when your PRs are merged",
		type: 1, // CHAT_INPUT
		integration_types: [0], // 0 = GUILD_INSTALL
		contexts: [0], // 0 = GUILD (not DM, not group DM)
	},
];

const url = guildId
	? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
	: `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
	method: "PUT",
	headers: {
		Authorization: `Bot ${botToken}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify(commands),
});

if (!res.ok) {
	const text = await res.text();
	console.error(`Failed to register commands (${res.status}): ${text}`);
	process.exit(1);
}

const data = await res.json();
console.log(`Registered ${data.length} command(s):`);
for (const cmd of data) {
	console.log(`  /${cmd.name} (${cmd.id})`);
}
