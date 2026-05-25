import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Backfill usage persisted before cost provenance was recorded. */
function normalizeUsageCostSource(usage: Usage): Usage {
	if (usage.cost.source === "provider" || usage.cost.source === "pi") return usage;
	return { ...usage, cost: { ...usage.cost, source: "pi" } };
}

function normalizeMessageUsage(message: AgentMessage): AgentMessage {
	if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
		return { ...message, usage: normalizeUsageCostSource(message.usage) };
	}
	return message;
}

interface UsageBearingEntry {
	type: string;
	message?: AgentMessage;
	usage?: Usage;
	retainedTail?: AgentMessage[];
}

/** Backfill usage provenance on entries loaded from older session formats. */
export function normalizeEntryUsage<T extends UsageBearingEntry>(entry: T): T {
	if (entry.type === "message" && entry.message) {
		const message = normalizeMessageUsage(entry.message);
		return message === entry.message ? entry : { ...entry, message };
	}
	if ((entry.type === "branch_summary" || entry.type === "usage") && entry.usage) {
		const usage = normalizeUsageCostSource(entry.usage);
		return usage === entry.usage ? entry : { ...entry, usage };
	}
	if (entry.type === "compaction") {
		const usage = entry.usage ? normalizeUsageCostSource(entry.usage) : undefined;
		const retainedTail = entry.retainedTail?.map(normalizeMessageUsage);
		return usage === entry.usage && retainedTail === undefined
			? entry
			: { ...entry, ...(usage ? { usage } : {}), ...(retainedTail ? { retainedTail } : {}) };
	}
	return entry;
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			source: first.cost.source === "provider" && second.cost.source === "provider" ? "provider" : "pi",
		},
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "usage") {
			key = `${entry.provider}/${entry.model}`;
			usage = entry.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
