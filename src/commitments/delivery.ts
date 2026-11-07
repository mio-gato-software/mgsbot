import { type Api, InputFile } from "grammy";
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
	if (message.image) {
		await api.sendPhoto(chatId, new InputFile(message.image, "report.png"), {
			caption: message.text.length <= 1000 ? message.text : undefined,
		});
		if (message.text.length <= 1000) return;
	}
	await api.sendMessage(chatId, message.text);
}
