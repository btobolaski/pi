import { normalizeUsageCostSource, type UsageRow, type UsageScan } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase, SqliteStatement } from "../types.ts";

export interface UsageLedgerRow {
	id: string;
	seq: number;
	entry_id: string | null;
	adjustment: number;
	usage: string;
	details: string | null;
}

const INSERT_USAGE_LEDGER_SQL = `INSERT INTO usage_ledger (session_id, id, seq, entry_id, adjustment, usage, details)
	VALUES (?, ?, ?, ?, ?, ?, ?)`;

function parseJson<T>(value: string, field: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`Invalid usage ledger ${field}`, { cause: error });
	}
}

function usageLedgerRowParams(sessionId: string, row: UsageRow): unknown[] {
	return [
		sessionId,
		row.id,
		row.seq,
		row.entryId ?? null,
		row.adjustment ? 1 : 0,
		JSON.stringify(row.usage),
		row.details === undefined ? null : JSON.stringify(row.details),
	];
}

export class UsageLedgerRowWriter {
	private readonly insertStatement: SqliteStatement;
	private readonly sessionId: string;

	constructor(db: SqliteDatabase, sessionId: string) {
		this.insertStatement = db.prepare(INSERT_USAGE_LEDGER_SQL);
		this.sessionId = sessionId;
	}

	insert(row: UsageRow): void {
		this.insertStatement.run(...usageLedgerRowParams(this.sessionId, row));
	}
}

export function insertUsageLedgerRow(db: SqliteDatabase, sessionId: string, row: UsageRow): void {
	db.prepare(INSERT_USAGE_LEDGER_SQL).run(...usageLedgerRowParams(sessionId, row));
}

export function decodeUsageLedgerRow(row: UsageLedgerRow): UsageRow {
	return {
		id: row.id,
		seq: row.seq,
		usage: normalizeUsageCostSource(parseJson<UsageRow["usage"]>(row.usage, "usage")),
		...(row.entry_id === null ? {} : { entryId: row.entry_id }),
		adjustment: row.adjustment !== 0,
		...(row.details === null ? {} : { details: parseJson<UsageRow["details"]>(row.details, "details") }),
	};
}

export function scanUsageLedgerRows(db: SqliteDatabase, sessionId: string, query: UsageScan): UsageLedgerRow[] {
	const filters: SqlQuery[] = [sql`session_id = ${sessionId}`];
	if (query.fromSeq !== undefined) filters.push(sql`seq >= ${query.fromSeq}`);
	if (query.toSeq !== undefined) filters.push(sql`seq <= ${query.toSeq}`);

	const order = query.order === "desc" ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`;
	const limit = query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`;
	return sql`SELECT id, seq, entry_id, adjustment, usage, details
		FROM usage_ledger WHERE ${joinSqlFragments(filters, " AND ")} ${order} ${limit}`.all<UsageLedgerRow>(db);
}
