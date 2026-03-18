export interface MediaAttachment {
	data: string;
	mimeType: string;
}

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	mediaAttachment?: MediaAttachment;
}

export interface ChatProvider {
	readonly name: string;
	model: string;
	generateResponse(
		systemPrompt: string,
		messages: ChatMessage[],
	): Promise<string>;
	describeImage?(
		imageBase64: string,
		mimeType: string,
		caption?: string,
	): Promise<string>;
}

export function supportsVision(
	provider: ChatProvider,
): provider is ChatProvider & Required<Pick<ChatProvider, "describeImage">> {
	return typeof provider.describeImage === "function";
}

export function supportsInlineImages(provider: ChatProvider): boolean {
	return provider.name === "gemini";
}
