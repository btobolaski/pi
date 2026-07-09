import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, source: "pi" },
	};
}

/** Backfill usage persisted before cost provenance was recorded. */
export function normalizeUsageCostSource(usage: Usage): Usage {
	if (usage.cost.source === "provider" || usage.cost.source === "pi") return usage;
	return { ...usage, cost: { ...usage.cost, source: "pi" } };
}

/** Backfill usage provenance on messages loaded from older session formats. */
export function normalizeMessageUsage(message: AgentMessage): AgentMessage {
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
	if (entry.type === "branch_summary" && entry.usage) {
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

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
			source: left.cost.source === "provider" && right.cost.source === "provider" ? "provider" : "pi",
		},
	};
}
