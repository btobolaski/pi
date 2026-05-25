import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([
		["milliseconds", { "retry-after-ms": "1000" }, 1000],
		["seconds", { "retry-after": "1" }, 1000],
		["HTTP date", { "retry-after": new Date(1000).toUTCString() }, 1000],
		["backoff", undefined, 500],
		["invalid headers", { "retry-after-ms": "invalid", "retry-after": "invalid" }, 500],
	] as const)("honors the %s retry delay", async (_kind, headers, delay) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, headers))
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry 404 by default", async () => {
		const error = providerError(404);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		await expect(retryProviderRequest(request, { maxRetries: 1 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("retries an explicitly added status", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(404, { "retry-after-ms": "10" }))
			.mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1, additionalRetryStatuses: [404] });
		await vi.advanceTimersByTimeAsync(9);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each(["provider", "caller"] as const)("honors the %s veto for an added status", async (veto) => {
		const error = providerError(404, veto === "provider" ? { "x-should-retry": "false" } : undefined);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		await expect(
			retryProviderRequest(request, {
				maxRetries: 1,
				additionalRetryStatuses: [404],
				noRetryStatuses: veto === "caller" ? [404] : undefined,
			}),
		).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(504, { "retry-after-ms": "0" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [504] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
