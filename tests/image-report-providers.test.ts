import { expect, test } from "bun:test";
import { reportAspectRatio } from "../src/image/types.ts";

test("a slightly taller report requests a portrait native aspect ratio", () => {
	expect(reportAspectRatio({ width: 900, height: 920 })).toBe("4:5");
	expect(reportAspectRatio({ width: 900, height: 900 })).toBe("1:1");
});

test("scheduled image providers receive portrait composition and ordinary requests retain their defaults", async () => {
	// Isolate SDK singletons and intercept all requests: never spend image credentials.
	const script = `
		import { OpenAIImageProvider } from './src/image/openai.ts';
		import { GeminiImageProvider } from './src/image/gemini.ts';
		import { FalImageProvider } from './src/image/fal.ts';
		const requests = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === 'https://fal.media/report.png') return new Response('pixels');
			requests.push(await request.json());
			if (new URL(request.url).hostname === 'fal.run') return Response.json({images:[{url:'https://fal.media/report.png'}]});
			if (request.url.includes('api.openai.com')) {
				return Response.json({ data: [{ b64_json: 'cGl4ZWxz' }] });
			}
			const chunk = { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'cGl4ZWxz' } }] } }] };
			return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
		};
		for (const Provider of [OpenAIImageProvider, GeminiImageProvider]) {
			const provider = new Provider();
			await provider.generateImage('Tabla: Equipo Azul 5-2', undefined, { allowText: true, dimensions: {width:1024,height:1536} });
			await provider.generateImage('A landscape');
		}
		for (const model of ['gpt-image-2', 'nano-banana-pro', 'nano-banana-2.1']) {
			process.env.FAL_IMAGE_MODEL = model;
			await new FalImageProvider().generateImage('Tabla de hoy', undefined, {dimensions:{width:1024,height:1536}});
		}
		console.log('RESULT:' + JSON.stringify(requests));
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
	expect(requests).toHaveLength(7);
	expect(requests[0].size).toBe("1024x1536");
	expect(requests[2].generationConfig.imageConfig.aspectRatio).toBe("2:3");
	expect(requests[3].generationConfig.imageConfig.aspectRatio).toBeUndefined();
	expect(requests[4].image_size).toEqual({ width: 1024, height: 1536 });
	expect(requests[5].aspect_ratio).toBe("2:3");
	expect(requests[6].aspect_ratio).toBe("2:3");
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
