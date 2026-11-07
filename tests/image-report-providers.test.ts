import { expect, test } from "bun:test";

test("character generation uploads the identity reference and preserves its medium without edit-composition instructions", async () => {
	const script = `
		import { mkdtemp, writeFile, rm } from 'node:fs/promises';
		import { join } from 'node:path';
		import { tmpdir } from 'node:os';
		import { OpenAIImageProvider } from './src/image/openai.ts';
		import { GeminiImageProvider } from './src/image/gemini.ts';
		const dir = await mkdtemp(join(tmpdir(), 'mgs-character-ref-'));
		const reference = join(dir, 'reference.jpg');
		await writeFile(reference, 'synthetic-reference-bytes');
		const requests = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.includes('api.openai.com')) {
				const form = await request.formData();
				const image = form.get('image');
				requests.push({ provider: 'openai', endpoint: new URL(request.url).pathname, prompt: form.get('prompt'), bytes: await image.text() });
				return Response.json({ data: [{ b64_json: 'cGl4ZWxz' }] });
			}
			const body = await request.json();
			const parts = body.contents[0].parts;
			requests.push({ provider: 'gemini', prompt: parts.find(p => p.text).text, bytes: Buffer.from(parts.find(p => p.inlineData).inlineData.data, 'base64').toString() });
			const chunk = { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'cGl4ZWxz' } }] } }] };
			return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
		};
		try {
			for (const Provider of [OpenAIImageProvider, GeminiImageProvider]) {
				const provider = new Provider();
				await provider.generateImage('wearing a camel coat in a snowy street', reference);
				await provider.editImage('add a hat', reference);
			}
			console.log('RESULT:' + JSON.stringify(requests));
		} finally { await rm(dir, { recursive: true, force: true }); }
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
	for (const i of [0, 2]) {
		expect(requests[i].bytes).toBe("synthetic-reference-bytes");
		expect(requests[i].prompt).toContain("SAME subject");
		expect(requests[i].prompt).toContain(
			"photographic reference should remain photographic",
		);
		expect(requests[i].prompt).toContain("snowy street");
		expect(requests[i].prompt).not.toContain("in cartoon illustration style");
		expect(requests[i].prompt).not.toContain(
			"Preserve the overall composition",
		);
		expect(requests[i + 1].prompt).toContain(
			"Preserve the overall composition",
		);
	}
	expect(requests[0].endpoint).toBe("/v1/images/edits");
});

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
