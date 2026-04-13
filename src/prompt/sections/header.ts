import { BOT_TZ, formatDateTime } from "../../bot-time.ts";
import type { PromptSection } from "../types.ts";

export const headerDatetime: PromptSection = {
	id: "header.datetime",
	render() {
		const now = formatDateTime();
		return `## Current date and time\n${now} (timezone: ${BOT_TZ})`;
	},
};
