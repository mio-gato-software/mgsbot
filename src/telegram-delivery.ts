/** A transport failure does not establish that Telegram rejected the message. */
export function isFormattingError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		/can't parse entities|cannot parse entities|unsupported start tag|can't find end of/i.test(
			error.message,
		) &&
		(!("error_code" in error) || error.error_code === 400)
	);
}

export function timeoutReply(language?: string): string {
	return language === "en"
		? "That took too long. Please try again in a moment."
		: "Eso tardó demasiado. Inténtalo de nuevo en un momento.";
}

/** A Telegram API rejection confirms failure; a lost network acknowledgement does not. */
export function isTelegramRejection(error: unknown): boolean {
	return (
		error instanceof Error &&
		"error_code" in error &&
		typeof error.error_code === "number" &&
		error.error_code >= 400 &&
		error.error_code < 600
	);
}

export async function withMarkdownFallback<T>(
	send: (parseMode?: "Markdown") => Promise<T>,
): Promise<T> {
	try {
		return await send("Markdown");
	} catch (error) {
		if (!isFormattingError(error)) throw error;
		return send();
	}
}
