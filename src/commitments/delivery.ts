import { type Api, InputFile } from "grammy";
import { withMarkdownFallback } from "../telegram-delivery.ts";
import type { BehaviorObservation } from "./behavior-runner.ts";

export interface ScheduledMessage {
	text: string;
	image?: Buffer;
	observation?: BehaviorObservation;
}

export async function deliverScheduledMessage(
	api: Pick<Api, "sendMessage" | "sendPhoto">,
	chatId: number,
	message: ScheduledMessage,
): Promise<void> {
	const image = message.image;
	if (image) {
		await withMarkdownFallback((parseMode) =>
			api.sendPhoto(chatId, new InputFile(image, "report.png"), {
				caption: message.text.length <= 1000 ? message.text : undefined,
				...(parseMode && message.text.length <= 1000
					? { parse_mode: parseMode }
					: {}),
			}),
		);
		if (message.text.length <= 1000) return;
	}
	await withMarkdownFallback((parseMode) =>
		api.sendMessage(
			chatId,
			message.text,
			parseMode ? { parse_mode: parseMode } : undefined,
		),
	);
}
