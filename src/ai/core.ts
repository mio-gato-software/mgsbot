import { type ChatMessage, createChatProvider } from "../providers/index.ts";

export async function generateResponse(
	systemPrompt: string,
	messages: ChatMessage[],
): Promise<string> {
	const provider = createChatProvider();
	return provider.generateResponse(systemPrompt, messages);
}
