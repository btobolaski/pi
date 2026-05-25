import { addUsage, normalizeUsageCostSource, type SessionStats, type UsageRow } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import { readSessionRow } from "./session-row.ts";

export function readSessionStats(db: SqliteDatabase, sessionId: string): SessionStats {
	const row = readSessionRow(db, sessionId);
	let usage: UsageRow["usage"];
	try {
		usage = normalizeUsageCostSource(JSON.parse(row.usage_payload) as UsageRow["usage"]);
	} catch (error) {
		throw new Error(`Invalid usage payload for session ${sessionId}`, { cause: error });
	}
	return { messageCount: row.message_count, usage };
}

export function incrementMessageCount(db: SqliteDatabase, sessionId: string): void {
	sql`UPDATE sessions SET message_count = message_count + 1 WHERE id = ${sessionId}`.run(db);
}

export function addUsageToSessionStats(db: SqliteDatabase, sessionId: string, usage: UsageRow["usage"]): void {
	const current = readSessionStats(db, sessionId).usage;
	sql`UPDATE sessions SET usage_payload = ${JSON.stringify(addUsage(current, usage))} WHERE id = ${sessionId}`.run(db);
}
