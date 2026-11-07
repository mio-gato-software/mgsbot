import { expect, test } from "bun:test";

test("OpenAI and Gemini image requests allow table text explicitly while ordinary photos retain their defaults", async () => {
	// Isolate SDK singletons and intercept all requests: never spend image credentials.
	const script = `
		import { OpenAIImageProvider } from './src/image/openai.ts';
		import { GeminiImageProvider } from './src/image/gemini.ts';
		const requests = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push(await request.json());
			if (request.url.includes('api.openai.com')) {
				return Response.json({ data: [{ b64_json: 'cGl4ZWxz' }] });
			}
			const chunk = { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'cGl4ZWxz' } }] } }] };
			return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
		};
		for (const Provider of [OpenAIImageProvider, GeminiImageProvider]) {
			const provider = new Provider();
			await provider.generateImage('Tabla: Equipo Azul 5-2', undefined, { allowText: true });
			await provider.generateImage('A landscape');
		}
		console.log('RESULT:' + JSON.stringify(requests));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: `${import.meta.dir}/..`,
		env: {
			...process.env,
			OPENAI_API_KEY: "test-no-network",
			GOOGLE_API_KEY: "test-no-network",
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
	const requests = JSON.parse(stdout.split("RESULT:")[1] ?? "[]");
	expect(requests).toHaveLength(4);
	const prompts = [
		requests[0].prompt,
		requests[1].prompt,
		requests[2].contents[0].parts[0].text,
		requests[3].contents[0].parts[0].text,
	];
	for (const i of [0, 2]) {
		expect(prompts[i]).toContain("Equipo Azul 5-2");
		expect(prompts[i]).toContain("accurately and legibly");
		expect(prompts[i]).not.toContain("Do NOT render any text");
		expect(prompts[i + 1]).toContain("Do NOT render any text");
	}
});
