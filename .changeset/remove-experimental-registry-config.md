---
"emdash": minor
"@emdash-cms/admin": minor
---

Removes the deprecated `experimental.registry` integration option. Sites that still set it now fail at startup with an error asking them to move the value to the top-level `registry` option. The value is not silently ignored, because that would drop the configured aggregator and release-age policy.

Move the value unchanged. The top-level option accepts the same URL string or configuration object:

```diff
 emdash({
-	experimental: {
-		registry: {
-			aggregatorUrl: "https://registry.example.com",
-			policy: { minimumReleaseAge: "48h" },
-		},
-	},
+	registry: {
+		aggregatorUrl: "https://registry.example.com",
+		policy: { minimumReleaseAge: "48h" },
+	},
 });
```

The `experimental` option is also removed from the `EmDashConfig` type, because it has no remaining settings. An empty `experimental: {}` block is still ignored at runtime, but TypeScript configs should delete it. Registry configuration errors in the admin now always name the top-level `registry.*` setting.
