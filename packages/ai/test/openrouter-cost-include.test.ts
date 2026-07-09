import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Model, Usage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function mockChunks(id: string, usage: Record<string, unknown> = { cost: 0.000123 }): void {
	mockState.chunks = [
		{ id, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
		{
			id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 50,
				prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				...usage,
			},
		},
	];
}

function expectCostSumToMatchTotal(cost: Usage["cost"]): void {
	expect(Math.abs(cost.input + cost.output + cost.cacheRead + cost.cacheWrite - cost.total)).toBeLessThan(1e-9);
}

function openRouterModel(): Model<"openai-completions"> {
	return getModel("openrouter", "google/gemini-2.5-flash");
}

function openRouterModelWithCompat(headers?: Model<"openai-completions">["headers"]): Model<"openai-completions"> {
	const model = openRouterModel();
	return {
		...model,
		headers: { ...model.headers, ...headers },
		compat: { ...model.compat, openRouterReconcileCostFromGenerationEndpoint: true },
	};
}

async function run(model = openRouterModelWithCompat(), options: Parameters<typeof complete>[2] = {}) {
	const pending = complete(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test", ...options },
	);
	await vi.runAllTimersAsync();
	return pending;
}

describe("openrouter cost inclusion", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockState.chunks = [];
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses OpenRouter streamed usage.cost and proportionally scales cost buckets", async () => {
		mockChunks("gen-streamed-cost", {
			cost: 0.000365,
			prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
		});
		const message = await run({
			...openRouterModel(),
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
		});

		expect(message.stopReason).toBe("stop");
		expect(message.responseId).toBe("gen-streamed-cost");
		expect(message.usage.cost.input).toBeCloseTo(0.00014);
		expect(message.usage.cost.output).toBeCloseTo(0.0002);
		expect(message.usage.cost.cacheRead).toBeCloseTo(0.00002);
		expect(message.usage.cost.cacheWrite).toBeCloseTo(0.000005);
		expect(message.usage.cost.total).toBe(0.000365);
		expect(message.usage.cost.source).toBe("provider");
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("falls back to pi table pricing when OpenRouter omits cost", async () => {
		mockChunks("gen-no-cost", {});
		const model = openRouterModel();
		const message = await run(model);
		const expectedInput = (model.cost.input / 1_000_000) * 100;
		const expectedOutput = (model.cost.output / 1_000_000) * 50;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.input).toBe(expectedInput);
		expect(message.usage.cost.output).toBe(expectedOutput);
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
	});

	it("ignores provider cost fields for non-OpenRouter providers", async () => {
		mockChunks("chatcmpl-non-openrouter", { prompt_tokens: 20, completion_tokens: 10, cost: 0.5 });
		const model = {
			...openRouterModel(),
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			id: "grok-3-mini",
			name: "Grok 3 Mini",
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		const message = await run(model);
		const expectedInput = (model.cost.input / 1_000_000) * 20;
		const expectedOutput = (model.cost.output / 1_000_000) * 10;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
		expect(message.usage.cost.total).not.toBe(0.5);
	});

	it("puts the entire provider total into input when streamed usage has zero tokens", async () => {
		mockChunks("gen-zero-tokens", { prompt_tokens: 0, completion_tokens: 0, cost: 1.23e-6 });
		const message = await run(openRouterModel());
		expect(message.usage.cost).toEqual({
			source: "provider",
			input: 1.23e-6,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1.23e-6,
		});
	});

	it("reconciles OpenRouter cost from the generation endpoint", async () => {
		mockChunks("gen-reconcile-success");
		const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => new Response('{"data":{"total_cost":0.5}}'));
		const message = await run(openRouterModelWithCompat({ "X-Model-Header": "model-value" }), {
			headers: { "X-Request-Header": "request-value" },
			fetch: fetchSpy,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, request] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-reconcile-success");
		expect(request?.method).toBe("GET");
		expect(request?.signal).toBeDefined();
		const requestHeaders = new Headers(request?.headers);
		expect(requestHeaders.get("authorization")).toBe("Bearer test");
		expect(requestHeaders.get("x-model-header")).toBe("model-value");
		expect(requestHeaders.get("x-request-header")).toBe("request-value");
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.5);
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("preserves explicit authorization headers during reconciliation", async () => {
		mockChunks("gen-header-auth");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"data":{"total_cost":0.5}}'));
		const message = await run(openRouterModelWithCompat(), {
			apiKey: undefined,
			headers: { Authorization: "Bearer header-token" },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer header-token");
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.5);
	});

	it("skips reconciliation rather than forwarding gateway credentials across origins", async () => {
		mockChunks("gen-custom-gateway");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected reconciliation request"));
		const message = await run(
			{ ...openRouterModelWithCompat(), baseUrl: "https://gateway.example/v1" },
			{ apiKey: undefined, headers: { Authorization: "Bearer gateway-secret" } },
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.000123);
	});

	it.each([404, 429, 500])("retries once after a %i generation lookup", async (status) => {
		mockChunks(`gen-retry-${status}`);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("not ready", { status }))
			.mockResolvedValueOnce(new Response('{"data":{"total_cost":0.5}}'));
		const message = await run();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(message.usage.cost.total).toBe(0.5);
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("skips generation reconciliation when responseId is not a gen id", async () => {
		mockChunks("chatcmpl-not-gen");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected reconciliation request"));
		const message = await run();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(message.responseId).toBe("chatcmpl-not-gen");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
	});

	it.each([
		["env-key", 1, 0.5, "Bearer env-key"],
		[undefined, 0, 0.000123, null],
	] as const)("resolves placeholder auth with environment key %s", async (key, calls, total, authorization) => {
		vi.stubEnv("OPENROUTER_API_KEY", key);
		mockChunks("gen-env-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"data":{"total_cost":0.5}}'));
		const message = await run(openRouterModelWithCompat(), { apiKey: "unused" });
		expect(fetchSpy).toHaveBeenCalledTimes(calls);
		expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(authorization);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(total);
	});

	it.each([
		["network", undefined, "network"],
		["invalid JSON", "not JSON", "parse"],
		["missing field", "{}", "missing_field"],
		["non-numeric total", '{"data":{"total_cost":"0.5"}}', "missing_field"],
		["non-finite total", '{"data":{"total_cost":1e400}}', "missing_field"],
	] as const)("keeps streamed cost after a %s lookup failure", async (_kind, body, category) => {
		mockChunks("gen-invalid-lookup");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			if (body === undefined) throw new Error("Offline");
			return new Response(body);
		});
		const message = await run();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "openrouter_cost_reconcile_failed",
			details: { category },
		});
	});

	it("bounds lookup time without a caller signal", async () => {
		mockChunks("gen-timeout");
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
			return controller.signal;
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_url, request) =>
				new Promise<Response>((_resolve, reject) => {
					request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
				}),
		);
		const message = await run();
		expect(timeout).toHaveBeenCalledWith(2000);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "openrouter_cost_reconcile_failed",
			details: { category: "network" },
		});
	});

	it("rejects a Retry-After delay beyond the lookup budget without retrying", async () => {
		mockChunks("gen-long-delay");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("not ready", { status: 429, headers: { "retry-after": "60" } }));
		const message = await run();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.diagnostics?.[0]?.details?.category).toBe("http_429");
	});

	it.each(["fetch", "retry"] as const)(
		"keeps a completed response when cancellation interrupts the reconcile %s",
		async (phase) => {
			mockChunks("gen-cancel-reconcile");
			const controller = new AbortController();
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, request) => {
				if (phase === "fetch") {
					controller.abort();
					throw request?.signal?.reason;
				}
				setTimeout(() => controller.abort(), 1);
				return new Response("not ready", { status: 404 });
			});
			const message = await run(openRouterModelWithCompat(), { signal: controller.signal });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(controller.signal.aborted).toBe(true);
			expect(message.stopReason).toBe("stop");
			expect(message.content).toEqual([{ type: "text", text: "hi" }]);
			expect(message.usage.cost.source).toBe("provider");
			expect(message.usage.cost.total).toBe(0.000123);
			expect(message.diagnostics).toBeUndefined();
		},
	);

	it("still aborts during streaming without starting reconciliation", async () => {
		mockChunks("gen-cancel-stream");
		const controller = new AbortController();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected reconciliation request"));
		const message = await run(openRouterModelWithCompat(), {
			signal: controller.signal,
			onProviderStreamEvent: () => controller.abort(),
		});
		expect(message.stopReason).toBe("aborted");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps streamed provider cost and records a diagnostic when reconciliation fails", async () => {
		mockChunks("gen-reconcile-fail");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("server error", { status: 500 }));
		const message = await run();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
		expect(message.diagnostics?.[0]?.type).toBe("openrouter_cost_reconcile_failed");
		expect(message.diagnostics?.[0]?.details?.category).toBe("http_500");
	});
});
