import { expect, test } from "bun:test";
import { deliverScheduledMessage } from "../src/commitments/delivery.ts";

type DeliveryApi = Parameters<typeof deliverScheduledMessage>[0];

for (const image of [false, true]) {
	test(`scheduled ${image ? "photo caption" : "text"} enables Telegram Markdown`, async () => {
		const sent: Array<{ method: string; text?: string; mode?: string }> = [];
		const api = {
			sendMessage: async (_chat, text, options) => {
				sent.push({ method: "text", text, mode: options?.parse_mode });
				return {} as never;
			},
			sendPhoto: async (_chat, _photo, options) => {
				sent.push({
					method: "photo",
					text: options?.caption,
					mode: options?.parse_mode,
				});
				return {} as never;
			},
		} satisfies DeliveryApi;
		const text =
			"*Resultados de ayer*\nEquipo Azul 5 - Equipo Verde 2\n_Resultado final._";
		await deliverScheduledMessage(api, -99, {
			text,
			...(image ? { image: Buffer.from("image") } : {}),
		});
		expect(sent).toEqual([
			{ method: image ? "photo" : "text", text, mode: "Markdown" },
		]);
	});

	test(`malformed ${image ? "caption" : "text"} retries once as plain text after a confirmed formatting rejection`, async () => {
		const modes: Array<string | undefined> = [];
		const attempt = async (mode?: string) => {
			modes.push(mode);
			if (modes.length === 1)
				throw Object.assign(new Error("Bad Request: can't parse entities"), {
					error_code: 400,
				});
			return {} as never;
		};
		const api = {
			sendMessage: async (_chat, _text, options) =>
				attempt(options?.parse_mode),
			sendPhoto: async (_chat, _photo, options) => attempt(options?.parse_mode),
		} satisfies DeliveryApi;
		await deliverScheduledMessage(api, -99, {
			text: "*unclosed",
			...(image ? { image: Buffer.from("image") } : {}),
		});
		expect(modes).toEqual(["Markdown", undefined]);
	});

	test(`uncertain ${image ? "photo" : "text"} delivery is never retried`, async () => {
		let attempts = 0;
		const failure = async () => {
			attempts++;
			throw new Error("Connection lost after sending");
		};
		await expect(
			deliverScheduledMessage(
				{ sendMessage: failure, sendPhoto: failure },
				-99,
				{ text: "*Report*", ...(image ? { image: Buffer.from("image") } : {}) },
			),
		).rejects.toThrow("Connection lost");
		expect(attempts).toBe(1);
	});
}

test("long formatted reports accompany the photo as separate text and a text-format rejection never resends the photo", async () => {
	let photos = 0;
	const modes: Array<string | undefined> = [];
	const text = `*Resultados de ayer*\n${"Datos de ejemplo. ".repeat(80)}`;
	const api = {
		sendPhoto: async (_chat, _photo, options) => {
			photos++;
			expect(options?.caption).toBeUndefined();
			return {} as never;
		},
		sendMessage: async (_chat, actual, options) => {
			expect(actual).toBe(text);
			modes.push(options?.parse_mode);
			if (modes.length === 1)
				throw Object.assign(new Error("can't find end of entity"), {
					error_code: 400,
				});
			return {} as never;
		},
	} satisfies DeliveryApi;
	await deliverScheduledMessage(api, -99, {
		text,
		image: Buffer.from("image"),
	});
	expect(photos).toBe(1);
	expect(modes).toEqual(["Markdown", undefined]);
});
