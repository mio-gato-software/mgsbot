export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ChatProvider {
	readonly name: string;
	model: string;
	generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string>;
}
