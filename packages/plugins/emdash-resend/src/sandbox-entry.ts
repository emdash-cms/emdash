import { definePlugin, type PluginContext } from "emdash";

async function buildSettingsPage(ctx: PluginContext) {
  const hasKey = !!(await ctx.kv.get<string>("settings:apiKey"));
  const fromAddress = (await ctx.kv.get<string>("settings:fromAddress")) ?? "";
  
  return {
    blocks: [
      {
        type: "section",
        text: "Configure your Resend API credentials to enable outbound emails.",
      },
      {
        type: "input",
        name: "apiKey",
        label: "Resend API Key",
        value: hasKey ? "********" : "",
        inputType: "password",
        placeholder: "re_...",
      },
      {
        type: "input",
        name: "fromAddress",
        label: "From Address",
        value: fromAddress,
        inputType: "text",
        placeholder: "EmDash <hello@yourdomain.com>",
      },
      {
        type: "button",
        text: "Save Settings",
        action: "save_settings",
        style: "primary",
      },
    ],
  };
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
  try {
    if (typeof values.apiKey === "string" && values.apiKey && values.apiKey !== "********") {
      await ctx.kv.set("settings:apiKey", values.apiKey);
    }
    
    if (typeof values.fromAddress === "string") {
      if (!values.fromAddress.includes("@")) {
        return {
          ...(await buildSettingsPage(ctx)),
          toast: { message: "Invalid From Address (must contain @)", type: "error" },
        };
      }
      await ctx.kv.set("settings:fromAddress", values.fromAddress);
    }
    
    return {
      ...(await buildSettingsPage(ctx)),
      toast: { message: "Settings saved successfully", type: "success" },
    };
  } catch (error) {
    ctx.log.error("Failed to save Resend settings", error);
    return {
      ...(await buildSettingsPage(ctx)),
      toast: { message: "Failed to save settings", type: "error" },
    };
  }
}

export default definePlugin({
  hooks: {
    "email:deliver": async (event: any, ctx: PluginContext) => {
      if (!ctx.http) {
        throw new Error("Missing network:fetch capability");
      }

      const apiKey = await ctx.kv.get<string>("settings:apiKey");
      const fromAddress = await ctx.kv.get<string>("settings:fromAddress");
      
      if (!apiKey || !fromAddress) {
        ctx.log.error("Cannot send email: Resend API key or From Address is missing");
        throw new Error("Resend credentials missing. Configure them in plugin settings.");
      }

      const { message } = event;
      
      const payload = {
        from: fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      };
      
      const response = await ctx.http.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Resend API returned ${response.status}: ${errorText}`);
      }
      
      ctx.log.info("Email delivered via Resend", { to: message.to });
    },
  },
  
  routes: {
    admin: {
      handler: async (routeCtx: { input: unknown; request: { url: string } }, ctx: PluginContext) => {
        const interaction = routeCtx.input as {
          type: string;
          page?: string;
          action_id?: string;
          values?: Record<string, unknown>;
        };

        if (interaction.type === "page_load" && interaction.page === "/settings") {
          return buildSettingsPage(ctx);
        }
        
        if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
          return saveSettings(ctx, interaction.values ?? {});
        }
        
        return { blocks: [] };
      },
    },
  },
});
