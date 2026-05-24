import "vitest-browser-react";
import { i18n } from "@lingui/core";

// Initialize i18n for browser tests with empty English messages
i18n.loadAndActivate({ locale: "en", messages: {} });
