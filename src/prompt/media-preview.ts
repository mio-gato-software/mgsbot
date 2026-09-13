/** Prompt-only previews. Durable sensory/spool messages keep complete extraction input. */
const MEDIA_MESSAGE_COMPACT_TARGET_CHARS = 240;
const MEDIA_MESSAGE_PATTERNS = [
	{
		regex: /^(\[Audio[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous transcription compacted",
	},
	{
		regex: /^(\[Image[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous visual description compacted",
	},
	{
		regex: /^(\[YouTube video[^\]]*\]:)\s*([\s\S]+)$/u,
		label: "Previous summary compacted",
	},
	{
		regex: /^(\[Plain-text attachment[^\]]*\])\s*([\s\S]+)$/u,
		label: "Previous text attachment compacted",
	},
] as const;

function normalizeForCompactPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function compactMediaMessageContent(content: string): string {
	for (const pattern of MEDIA_MESSAGE_PATTERNS) {
		const match = content.match(pattern.regex);
		if (!match) continue;

		const prefix = match[1] ?? content;
		const body = normalizeForCompactPreview(match[2] ?? "");
		if (!body) return prefix;
		if (body.startsWith(`[${pattern.label}]`)) {
			return `${prefix} ${body}`;
		}
		if (body.length <= MEDIA_MESSAGE_COMPACT_TARGET_CHARS) {
			return `${prefix} ${body}`;
		}

		const truncated = body
			.slice(0, MEDIA_MESSAGE_COMPACT_TARGET_CHARS)
			.trimEnd();
		return `${prefix} [${pattern.label}] ${truncated}...`;
	}

	return content;
}
