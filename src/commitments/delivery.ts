import { type Api, InputFile } from "grammy";
import { withMarkdownFallback } from "../telegram-delivery.ts";
import type { BehaviorObservation } from "./behavior-runner.ts";

export interface ScheduledMessage {
	text: string;
	delivery?: "image_only";
	image?: Buffer;
	observation?: BehaviorObservation;
}

export async function deliverScheduledMessage(
	api: Pick<Api, "sendMessage" | "sendPhoto">,
	chatId: number,
	message: ScheduledMessage,
): Promise<void> {
	const image = message.image;
	if (message.delivery === "image_only" && !image)
		throw new Error("Image-only report has no image");
	if (image) {
		await withMarkdownFallback((parseMode) =>
			api.sendPhoto(chatId, new InputFile(image, "report.png"), {
				caption:
					message.delivery !== "image_only" && message.text.length <= 1000
						? message.text
						: undefined,
				...(parseMode &&
				message.delivery !== "image_only" &&
				message.text.length <= 1000
					? { parse_mode: parseMode }
					: {}),
			}),
		);
		if (message.delivery === "image_only" || message.text.length <= 1000)
			return;
	}
	for (let offset = 0; offset < message.text.length; ) {
		let end = Math.min(offset + 4000, message.text.length);
		// Keep each chunk bounded without separating an emoji's surrogate pair.
		const last = message.text.charCodeAt(end - 1);
		if (end < message.text.length && last >= 0xd800 && last <= 0xdbff) end--;
		const chunk = message.text.slice(offset, end);
		await withMarkdownFallback((parseMode) =>
			api.sendMessage(
				chatId,
				chunk,
				parseMode ? { parse_mode: parseMode } : undefined,
			),
		);
		offset = end;
	}
}
