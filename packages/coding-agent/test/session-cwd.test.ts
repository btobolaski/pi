import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";

const selectSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../src/cli/session-picker.ts", () => ({ selectSession: selectSessionMock }));

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Reject with a usable hint instead of hanging until the suite-wide timeout, for calls that
 * would block on an interactive prompt reading real stdin if the code under test regressed.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, hint: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(hint)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function writeSessionFile(path: string, cwd: string, id = "session-id"): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-override-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-runtime-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});
});

describe("--cwd session resolution", () => {
	const cleanupPaths: string[] = [];
	let restoreAgentDirEnv: (() => void) | undefined;

	afterEach(() => {
		restoreAgentDirEnv?.();
		restoreAgentDirEnv = undefined;
		selectSessionMock.mockReset();
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	function createProject(): { launchCwd: string; storedCwd: string; sessionDir: string; agentDir: string } {
		const dirs = {
			launchCwd: createTempDir("pi-cwd-launch"),
			storedCwd: createTempDir("pi-cwd-stored"),
			sessionDir: createTempDir("pi-cwd-sessions"),
			agentDir: createTempDir("pi-cwd-agent"),
		};
		cleanupPaths.push(dirs.launchCwd, dirs.storedCwd, dirs.sessionDir, dirs.agentDir);
		return dirs;
	}

	/** Point the default session lookup, used when `--session-dir` is omitted, at a temp agent dir. */
	function useAgentDir(agentDir: string): void {
		const original = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		restoreAgentDirEnv = () => {
			if (original === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = original;
			}
		};
	}

	async function resolveSession(
		args: Args,
		launchCwd: string,
		sessionDir: string | undefined,
		agentDir: string,
	): Promise<SessionManager> {
		return createSessionManager(args, launchCwd, sessionDir, SettingsManager.create(launchCwd, agentDir));
	}

	it("runs a session named by path in the launch cwd", async () => {
		const { launchCwd, storedCwd, sessionDir, agentDir } = createProject();
		const sessionFile = join(sessionDir, "session.jsonl");
		writeSessionFile(sessionFile, storedCwd);

		const sessionManager = await resolveSession(
			parseArgs(["--session", sessionFile, "--cwd"]),
			launchCwd,
			sessionDir,
			agentDir,
		);

		expect(sessionManager.getCwd()).toBe(launchCwd);
		// The override changes where the session runs, not which file it appends to.
		expect(sessionManager.getSessionFile()).toBe(sessionFile);
	});

	it("keeps the stored cwd when the flag is absent", async () => {
		const { launchCwd, storedCwd, sessionDir, agentDir } = createProject();
		const sessionFile = join(sessionDir, "session.jsonl");
		writeSessionFile(sessionFile, storedCwd);

		const sessionManager = await resolveSession(
			parseArgs(["--session", sessionFile]),
			launchCwd,
			sessionDir,
			agentDir,
		);

		expect(sessionManager.getCwd()).toBe(storedCwd);
	});

	it("opens a session from another project in place, still reporting where it came from", async () => {
		const { launchCwd, storedCwd, sessionDir, agentDir } = createProject();
		const sessionFile = join(sessionDir, "2026-07-31T00-00-00-000Z_foreign-session.jsonl");
		writeSessionFile(sessionFile, storedCwd, "foreign-session");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			// Resolving by id rather than path takes the "different project" branch.
			const sessionManager = await withDeadline(
				resolveSession(parseArgs(["--session", "foreign-session", "--cwd"]), launchCwd, sessionDir, agentDir),
				2000,
				"Session resolution never settled: --cwd stopped skipping the fork confirmation prompt",
			);

			expect(sessionManager.getCwd()).toBe(launchCwd);
			expect(sessionManager.getSessionFile()).toBe(sessionFile);
			expect(logSpy.mock.calls.flat().join("\n")).toContain("Session found in different project");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("runs a session picked by --resume in the launch cwd", async () => {
		const { launchCwd, storedCwd, sessionDir, agentDir } = createProject();
		const sessionFile = join(sessionDir, "session.jsonl");
		writeSessionFile(sessionFile, storedCwd);
		selectSessionMock.mockResolvedValue(sessionFile);

		const sessionManager = await resolveSession(parseArgs(["--resume", "--cwd"]), launchCwd, sessionDir, agentDir);

		expect(selectSessionMock).toHaveBeenCalledOnce();
		expect(sessionManager.getCwd()).toBe(launchCwd);
	});

	it("resumes by id through session directories shared between worktrees", async () => {
		const { launchCwd, storedCwd, agentDir } = createProject();
		useAgentDir(agentDir);
		const storedSessionDir = getDefaultSessionDir(storedCwd);
		writeSessionFile(join(storedSessionDir, "session.jsonl"), storedCwd, "shared-session");

		// Symlink the launch cwd's session directory onto the stored cwd's, as the worktree
		// workflow does, so the session is discoverable without an explicit --session-dir.
		const launchSessionDir = getDefaultSessionDir(launchCwd);
		rmSync(launchSessionDir, { recursive: true, force: true });
		symlinkSync(storedSessionDir, launchSessionDir, "dir");

		const sessionManager = await resolveSession(
			parseArgs(["--session-id", "shared-session", "--cwd"]),
			launchCwd,
			// An explicit --session-dir would filter the listing down to sessions whose stored cwd
			// already matches, which excludes exactly the sessions this flag exists for.
			undefined,
			agentDir,
		);

		expect(sessionManager.getCwd()).toBe(launchCwd);
	});
});
