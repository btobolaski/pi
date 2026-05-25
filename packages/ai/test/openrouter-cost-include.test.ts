import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

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
							for (const chunk of chunks) {
								yield chunk;
							}
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

function sumCost(cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
	return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

function expectCostSumToMatchTotal(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}) {
	expect(Math.abs(sumCost(cost) - cost.total)).toBeLessThan(1e-9);
}

function openRouterModel(): Model<"openai-completions"> {
	return getModel("openrouter", "google/gemini-2.5-flash");
}

function openRouterModelWithCompat(headers?: Model<"openai-completions">["headers"]): Model<"openai-completions"> {
	const model = openRouterModel();
	return {
		...model,
		headers: { ...model.headers, ...headers },
		compat: {
			...model.compat,
			openRouterReconcileCostFromGenerationEndpoint: true,
		},
	};
}

function nonOpenRouterCompletionsModel(): Model<"openai-completions"> {
	return {
		...openRouterModel(),
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		id: "grok-3-mini",
		name: "Grok 3 Mini",
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("openrouter cost inclusion", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("uses OpenRouter streamed usage.cost and proportionally scales cost buckets", async () => {
		mockState.chunks = [
			{
				id: "gen-streamed-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-streamed-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000365,
					prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
				},
			},
		];

		const message = await complete(
			{
				...openRouterModel(),
				cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
			},
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

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
		mockState.chunks = [
			{
				id: "gen-no-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-no-cost",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const model = openRouterModel();
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const expectedInput = (model.cost.input / 1_000_000) * 100;
		const expectedOutput = (model.cost.output / 1_000_000) * 50;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.input).toBe(expectedInput);
		expect(message.usage.cost.output).toBe(expectedOutput);
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
	});

	it("ignores provider cost fields for non-OpenRouter providers", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-non-openrouter",
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-non-openrouter",
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 10,
					cost: 0.5,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const model = nonOpenRouterCompletionsModel();
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const expectedInput = (model.cost.input / 1_000_000) * 20;
		const expectedOutput = (model.cost.output / 1_000_000) * 10;
		expect(message.usage.cost.source).toBe("pi");
		expect(message.usage.cost.total).toBe(expectedInput + expectedOutput);
		expect(message.usage.cost.total).not.toBe(0.5);
	});

	it("puts the entire provider total into input when streamed usage has zero tokens", async () => {
		mockState.chunks = [
			{
				id: "gen-zero-tokens",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 0,
					completion_tokens: 0,
					cost: 1.23e-6,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.input).toBe(1.23e-6);
		expect(message.usage.cost.output).toBe(0);
		expect(message.usage.cost.cacheRead).toBe(0);
		expect(message.usage.cost.cacheWrite).toBe(0);
		expect(message.usage.cost.total).toBe(1.23e-6);
	});

	it("reconciles OpenRouter cost from the generation endpoint", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: { total_cost: 0.5 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		mockState.chunks = [
			{
				id: "gen-reconcile-success",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			},
			{
				id: "gen-reconcile-success",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat({ "X-Model-Header": "model-value" }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", headers: { "X-Request-Header": "request-value" }, fetch: fetchSpy },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

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
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: { total_cost: 0.5 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		mockState.chunks = [
			{
				id: "gen-header-auth",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ headers: { Authorization: "Bearer header-token" } },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const requestHeaders = new Headers(fetchSpy.mock.calls[0]![1]?.headers);
		expect(requestHeaders.get("authorization")).toBe("Bearer header-token");
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.5);
	});

	it("skips reconciliation rather than forwarding gateway credentials across origins", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		mockState.chunks = [
			{
				id: "gen-custom-gateway",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			{ ...openRouterModelWithCompat(), baseUrl: "https://gateway.example/v1" },
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ headers: { Authorization: "Bearer gateway-secret" } },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(message.usage.cost.source).toBe("provider");
		expect(message.usage.cost.total).toBe(0.000123);
	});

	it.each([404, 429, 500])("retries once after a %i generation lookup", async (status) => {
		vi.useFakeTimers();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("not ready", { status }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { total_cost: 0.5 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		mockState.chunks = [
			{
				id: `gen-retry-${status}`,
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(message.usage.cost.total).toBe(0.5);
		expectCostSumToMatchTotal(message.usage.cost);
	});

	it("skips generation reconciliation when responseId is not a gen id", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		mockState.chunks = [
			{
				id: "chatcmpl-not-gen",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(message.responseId).toBe("chatcmpl-not-gen");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
	});

	it("keeps streamed provider cost and records a diagnostic when reconciliation fails", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("server error", { status: 500 }))
			.mockResolvedValueOnce(new Response("server error", { status: 500 }));
		mockState.chunks = [
			{
				id: "gen-reconcile-fail",
				model: "google/gemini-2.5-flash",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					cost: 0.000123,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
			},
		];

		const messagePromise = complete(
			openRouterModelWithCompat(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		await vi.runAllTimersAsync();
		const message = await messagePromise;

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBe(0.000123);
		expect(message.usage.cost.source).toBe("provider");
		expect(message.diagnostics?.[0]?.type).toBe("openrouter_cost_reconcile_failed");
		expect(message.diagnostics?.[0]?.details?.category).toBe("http_500");
	});
});
