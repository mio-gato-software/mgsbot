import { expect, test } from "bun:test";

test("OpenAI sends the question and image in one Responses request, preserving text-only history", async () => {
	// Isolate the SDK singleton and credentials from the rest of the test suite.
	const script = `
		import { getOpenAIClient } from './src/ai/openai-client.ts';
		import { OpenAIChatProvider } from './src/providers/openai.ts';
		import { supportsInlineImages } from './src/providers/types.ts';
		let requests = [];
		getOpenAIClient().responses.create = async (body) => {
			requests.push(body);
			return { output_text: 'The sign says EXIT' };
		};
		const provider = new OpenAIChatProvider();
		const reply = await provider.generateResponse('system', [
			{ role: 'assistant', content: 'What would you like to know?' },
			{ role: 'user', content: 'Read the sign', mediaAttachment: { data: 'pixels', mimeType: 'image/png' } },
		]);
		console.log('RESULT:' + JSON.stringify({ requests, reply, inline: supportsInlineImages(provider) }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: `${import.meta.dir}/..`,
		env: {
			...process.env,
			OPENAI_API_KEY: "test-no-network",
			NODE_ENV: "production",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const result = JSON.parse(stdout.split("RESULT:")[1] ?? "{}");
	expect(result.inline).toBe(true);
	expect(result.requests).toHaveLength(1);
	expect(result.requests[0].input).toEqual([
		{ role: "system", content: "system" },
		{ role: "assistant", content: "What would you like to know?" },
		{
			role: "user",
			content: [
				{ type: "input_text", text: "Read the sign" },
				{
					type: "input_image",
					image_url: "data:image/png;base64,pixels",
					detail: "auto",
				},
			],
		},
	]);
});
