import { describe, expect, test } from "bun:test";
import {
	buildReplyOptions,
	extractQuoteReplyMarker,
	IMAGE_MARKER_REGEX,
	IMAGE_SELF_MARKER_REGEX,
	QUOTE_REPLY_MARKER,
	REACTION_MARKER_REGEX,
	SILENCE_MARKER,
} from "../src/response-processor.ts";

describe("response markers", () => {
	test("[IMAGE:...] captures the prompt", () => {
		const m = "Listo [IMAGE: un gato en la playa] disfruta".match(
			IMAGE_MARKER_REGEX,
		);
		expect(m?.[1]?.trim()).toBe("un gato en la playa");
	});

	test("[IMAGE_SELF:...] matches even when [IMAGE:...] would also match", () => {
		const text = "[IMAGE_SELF: yo sonriendo] hola";
		const self = text.match(IMAGE_SELF_MARKER_REGEX);
		expect(self?.[1]?.trim()).toBe("yo sonriendo");
	});

	test("[REACT:emoji] captures the emoji", () => {
		const m = "[REACT: 🔥] que fuerte".match(REACTION_MARKER_REGEX);
		expect(m?.[1]?.trim()).toBe("🔥");
	});

	test("[SILENCE] is a fixed marker", () => {
		expect(SILENCE_MARKER).toBe("[SILENCE]");
		expect("[SILENCE]".trim() === SILENCE_MARKER).toBe(true);
	});

	test("[QUOTE_REPLY] is stripped and tracked", () => {
		const result = extractQuoteReplyMarker(
			`${QUOTE_REPLY_MARKER} Claro, eso iba por ahí.`,
		);
		expect(result).toEqual({
			responseText: "Claro, eso iba por ahí.",
			quoteReplyRequested: true,
		});
	});

	test("group replies are normal messages unless quote marker is requested", () => {
		expect(
			buildReplyOptions({
				isGroup: true,
				messageId: 123,
				quoteReplyRequested: false,
			}),
		).toEqual({});
		expect(
			buildReplyOptions({
				isGroup: true,
				messageId: 123,
				quoteReplyRequested: true,
			}),
		).toEqual({
			reply_parameters: {
				message_id: 123,
				allow_sending_without_reply: true,
			},
		});
	});

	test("regexes do not match when markers are absent", () => {
		const text = "hola como estas";
		expect(IMAGE_MARKER_REGEX.test(text)).toBe(false);
		expect(IMAGE_SELF_MARKER_REGEX.test(text)).toBe(false);
		expect(REACTION_MARKER_REGEX.test(text)).toBe(false);
		expect(text.includes(SILENCE_MARKER)).toBe(false);
	});
});
