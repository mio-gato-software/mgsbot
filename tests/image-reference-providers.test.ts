import { expect, test } from "bun:test";

test("reference requests carry the original image and composition guidance for the requested operation", async () => {
	const script = `
		import { mkdtemp, writeFile, rm } from 'node:fs/promises';
		import { join } from 'node:path';
		import { tmpdir } from 'node:os';
		import { OpenAIImageProvider } from './src/image/openai.ts';
		import { GeminiImageProvider } from './src/image/gemini.ts';
		import { FalImageProvider } from './src/image/fal.ts';
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
			if (request.url === 'https://example.com/result.png') return new Response('pixels');
			const body = await request.json();
			if (new URL(request.url).hostname === 'fal.run') {
				requests.push({ provider: 'fal', prompt: body.prompt, bytes: Buffer.from(body.image_urls[0].split(',')[1], 'base64').toString() });
				return Response.json({ images: [{ url: 'https://example.com/result.png' }] });
			}
			const parts = body.contents[0].parts;
			requests.push({ provider: 'gemini', prompt: parts.find(p => p.text).text, bytes: Buffer.from(parts.find(p => p.inlineData).inlineData.data, 'base64').toString() });
			const chunk = { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'cGl4ZWxz' } }] } }] };
			return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
		};
		try {
			for (const Provider of [OpenAIImageProvider, GeminiImageProvider, FalImageProvider]) {
				const provider = new Provider();
				await provider.generateImage('wearing a camel coat in a snowy street', reference);
				await provider.editImage('show the person watching a kite overhead', reference);
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
			FAL_API_KEY: "test-no-network",
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
	expect(requests).toHaveLength(9);
	for (const request of requests) {
		expect(request.bytes).toBe("synthetic-reference-bytes");
		expect(request.prompt).toContain("camera viewpoint");
		expect(request.prompt).toContain("body, head and gaze");
	}
	for (const i of [0, 3, 6]) {
		expect(requests[i].prompt).toContain("SAME subject");
		expect(requests[i].prompt).toContain(
			"facial identity and body proportions",
		);
		expect(requests[i].prompt).toContain("over conflicting scene descriptions");
		expect(requests[i].prompt).toContain("Vary clothing, pose and setting");
		expect(requests[i].prompt).toContain(
			"photographic reference should remain photographic",
		);
		expect(requests[i].prompt).toContain("snowy street");
		expect(requests[i].prompt).not.toContain("in cartoon illustration style");
		expect(requests[i + 1].prompt).toContain("watching a kite overhead");
		expect(requests[i + 1].prompt).toContain("new scene or action");
		expect(requests[i + 2].prompt).toContain("add a hat");
		expect(requests[i + 2].prompt).toContain("preserve the original pose");
		expect(requests[i + 2].prompt).not.toContain("Create a new image");
	}
	expect(requests[0].endpoint).toBe("/v1/images/edits");
});
