export const IMAGE_MARKER_REGEX = /\[IMAGE:\s*([^\]]+)\]/;
export const IMAGE_SELF_MARKER_REGEX = /\[IMAGE_SELF:\s*([^\]]+)\]/;
export const REACTION_MARKER_REGEX = /\[REACT:\s*([^\]]+)\]/;
export const QUOTE_REPLY_MARKER = "[QUOTE_REPLY]";
export const SILENCE_MARKER = "[SILENCE]";

const QUOTE_REPLY_MARKER_REGEX = /\[QUOTE_REPLY\]/g;

export function extractQuoteReplyMarker(responseText: string): {
	responseText: string;
	quoteReplyRequested: boolean;
} {
	const quoteReplyRequested = responseText.includes(QUOTE_REPLY_MARKER);
	return {
		responseText: responseText.replace(QUOTE_REPLY_MARKER_REGEX, "").trim(),
		quoteReplyRequested,
	};
}

export function buildReplyOptions(input: {
	isGroup: boolean;
	messageId?: number;
	quoteReplyRequested: boolean;
}): {
	reply_parameters?: {
		message_id: number;
		allow_sending_without_reply: true;
	};
} {
	if (!input.isGroup || !input.quoteReplyRequested || !input.messageId) {
		return {};
	}
	return {
		reply_parameters: {
			message_id: input.messageId,
			allow_sending_without_reply: true,
		},
	};
}

export interface ResponsePlan {
	text: string;
	textOutsideSpeech: string;
	speech?: string;
	image?: { prompt: string; self: boolean };
	reaction?: string;
	quoteReplyRequested: boolean;
}

/** Parse model output without performing network or storage operations. */
export function parseResponse(
	responseText: string,
	options: { allowImages: boolean; allowSpeech: boolean },
): ResponsePlan {
	const { responseText: unquoted, quoteReplyRequested } =
		extractQuoteReplyMarker(responseText);
	let text = unquoted.replaceAll(SILENCE_MARKER, "").trim();
	const reaction = text.match(REACTION_MARKER_REGEX)?.[1]?.trim();
	text = text.replace(/\[REACT:\s*[^\]]+\]/g, "").trim();
	const selfMatch = text.match(IMAGE_SELF_MARKER_REGEX);
	const imageMatch = selfMatch ?? text.match(IMAGE_MARKER_REGEX);
	const image =
		options.allowImages && imageMatch?.[1]?.trim()
			? { prompt: imageMatch[1].trim(), self: !!selfMatch }
			: undefined;
	text = text.replace(/\[IMAGE(?:_SELF)?:\s*[^\]]+\]/g, "").trim();
	const speechPattern = /\[TTS\]([\s\S]+?)\[\/?TTS\]/g;
	const speeches = [...text.matchAll(speechPattern)]
		.map((match) => match[1]?.trim() ?? "")
		.filter(Boolean);
	const textOutsideSpeech = text.replace(speechPattern, "").trim();
	text = text.replace(speechPattern, "$1").trim();
	return {
		text,
		textOutsideSpeech,
		speech:
			options.allowSpeech && speeches.length ? speeches.join("\n") : undefined,
		image,
		reaction,
		quoteReplyRequested,
	};
}
