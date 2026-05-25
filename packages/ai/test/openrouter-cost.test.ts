import { describe, expect, it } from "vitest";
import type { Usage } from "../src/types.ts";
import { applyOpenRouterCost, applyOpenRouterReportedCost, isOpenRouterModel } from "../src/utils/openrouter-cost.ts";

function usage(total = 1): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("isOpenRouterModel", () => {
	it("recognizes both the built-in provider and custom providers using OpenRouter's endpoint", () => {
		expect(isOpenRouterModel({ provider: "openrouter", baseUrl: "https://example.com" })).toBe(true);
		expect(isOpenRouterModel({ provider: "openrouter-work", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://example.com/v1" })).toBe(false);
	});
});

describe("applyOpenRouterCost", () => {
	it("rescales every component, including a later reconciliation", () => {
		const value = usage();
		value.cost = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 };
		applyOpenRouterCost(value, 2);
		expect(value.cost).toEqual({
			input: 0.2,
			output: 0.4,
			cacheRead: 0.6,
			cacheWrite: 0.8,
			total: 2,
			totalFromProvider: true,
		});
		applyOpenRouterCost(value, 0.5);
		expect(value.cost).toEqual({
			input: 0.05,
			output: 0.1,
			cacheRead: 0.15,
			cacheWrite: 0.2,
			total: 0.5,
			totalFromProvider: true,
		});
	});

	it("assigns the entire bill to input without a catalog estimate", () => {
		const value = usage(0);
		applyOpenRouterCost(value, 0.5);
		expect(value.cost).toEqual({
			input: 0.5,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.5,
			totalFromProvider: true,
		});
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("ignores an invalid total %s", (total) => {
		const value = usage();
		const before = { ...value.cost };
		applyOpenRouterCost(value, total);
		expect(value.cost).toEqual(before);
	});
});

describe("applyOpenRouterReportedCost", () => {
	it("uses OpenRouter's reported cost for non-BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0,
			is_byok: false,
			cost_details: {
				upstream_inference_cost: 0,
				upstream_inference_prompt_cost: 0,
				upstream_inference_completions_cost: 0,
			},
		});
		expect(value.cost.total).toBe(0);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("adds the upstream inference cost for BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: 0.9,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBe(1);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("uses upstream cost components when OpenRouter omits their total", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: null,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBeCloseTo(1);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("keeps the catalog total when OpenRouter's accounting is incomplete", () => {
		const value = usage();
		value.cost.totalFromProvider = false;
		applyOpenRouterReportedCost(value, { cost: null, is_byok: false, cost_details: null });
		applyOpenRouterReportedCost(value, { cost: 0.1, is_byok: true, cost_details: null });
		expect(value.cost.total).toBe(1);
		expect(value.cost.totalFromProvider).toBe(false);
	});
});
