import { alertOwner, errorSummary } from "../alerts.ts";
import { type ChatMessage, createChatProvider } from "../providers/index.ts";

export async function generateResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	const provider = createChatProvider();
	try {
		return await provider.generateResponse(systemPrompt, messages);
	} catch (error) {
		await alertOwner(
			"chat-provider",
			`${provider.name} request failed: ${errorSummary(error)}`,
		);
		throw error;
	}
}
