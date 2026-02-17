import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { PtySummary } from "../types.js";

export type PersistedEvent = {
  sessionId: string;
  ts: number;
  type: string;
  payload: unknown;
};

export type InputHistoryEntry = {
  text: string;
  bufferLine: number;
};

export type InputMeta = {
  lastInput?: string;
  processHint?: string;
  history: InputHistoryEntry[];
};

export class SqliteStore {
  private db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        name text not null,
        backend text,
        tmux_session text,
        command text not null,
        args_json text not null,
        cwd text,
        created_at integer not null,
        last_seen_at integer not null,
        status text not null,
        exit_code integer,
        exit_signal text
      );

      create table if not exists events (
        id integer primary key autoincrement,
        session_id text not null,
        ts integer not null,
        type text not null,
        payload_json text not null
      );

      create index if not exists idx_events_session_ts on events(session_id, ts);

      create table if not exists input_history (
        session_id text primary key,
        last_input text,
        process_hint text,
        history_json text not null default '[]',
        updated_at integer not null
      );

      create table if not exists preferences (
        key text primary key,
        value_json text not null,
        updated_at integer not null
      );
    `);

    // Backwards-compatible column adds for existing DBs.
    const cols = this.db.prepare(`pragma table_info(sessions);`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("backend")) {
      this.db.exec(`alter table sessions add column backend text;`);
    }
    if (!have.has("tmux_session")) {
      this.db.exec(`alter table sessions add column tmux_session text;`);
    }
  }

  upsertSession(summary: PtySummary): void {
    const stmt = this.db.prepare(`
      insert into sessions (
        id, name, backend, tmux_session, command, args_json, cwd, created_at, last_seen_at, status, exit_code, exit_signal
      ) values (
        @id, @name, @backend, @tmux_session, @command, @args_json, @cwd, @created_at, @last_seen_at, @status, @exit_code, @exit_signal
      )
      on conflict(id) do update set
        name=excluded.name,
        backend=excluded.backend,
        tmux_session=excluded.tmux_session,
        command=excluded.command,
        args_json=excluded.args_json,
        cwd=excluded.cwd,
        last_seen_at=excluded.last_seen_at,
        status=excluded.status,
        exit_code=excluded.exit_code,
        exit_signal=excluded.exit_signal;
    `);

    stmt.run({
      id: summary.id,
      name: summary.name,
      backend: summary.backend ?? null,
      tmux_session: summary.tmuxSession ?? null,
      command: summary.command,
      args_json: JSON.stringify(summary.args),
      cwd: summary.cwd,
      created_at: summary.createdAt,
      last_seen_at: Date.now(),
      status: summary.status,
      exit_code: summary.exitCode ?? null,
      exit_signal: summary.exitSignal ?? null,
    });
  }

  insertEvent(evt: PersistedEvent): void {
    const stmt = this.db.prepare(`
      insert into events (session_id, ts, type, payload_json)
      values (@session_id, @ts, @type, @payload_json);
    `);
    stmt.run({
      session_id: evt.sessionId,
      ts: evt.ts,
      type: evt.type,
      payload_json: JSON.stringify(evt.payload ?? null),
    });
  }

  listSessions(limit = 200): PtySummary[] {
    const stmt = this.db.prepare(`
      select id, name, backend, tmux_session, command, args_json, cwd, created_at, status, exit_code, exit_signal
      from sessions
      order by created_at desc
      limit ?;
    `);
    const rows = stmt.all(limit) as Array<{
      id: string;
      name: string;
      backend: string | null;
      tmux_session: string | null;
      command: string;
      args_json: string;
      cwd: string | null;
      created_at: number;
      status: string;
      exit_code: number | null;
      exit_signal: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      backend: r.backend === "tmux" ? "tmux" : r.backend === "pty" ? "pty" : undefined,
      tmuxSession: r.tmux_session,
      command: r.command,
      args: this.parseArgsJson(r.args_json),
      cwd: r.cwd,
      createdAt: r.created_at,
      status: r.status === "running" ? "running" : "exited",
      exitCode: r.exit_code,
      exitSignal: r.exit_signal,
    }));
  }

  saveInputHistory(sessionId: string, meta: InputMeta): void {
    const stmt = this.db.prepare(`
      insert into input_history (session_id, last_input, process_hint, history_json, updated_at)
      values (@session_id, @last_input, @process_hint, @history_json, @updated_at)
      on conflict(session_id) do update set
        last_input=excluded.last_input,
        process_hint=excluded.process_hint,
        history_json=excluded.history_json,
        updated_at=excluded.updated_at;
    `);
    stmt.run({
      session_id: sessionId,
      last_input: meta.lastInput ?? null,
      process_hint: meta.processHint ?? null,
      history_json: JSON.stringify(meta.history),
      updated_at: Date.now(),
    });
  }

  loadAllInputHistory(): Record<string, InputMeta> {
    const stmt = this.db.prepare(`
      select session_id, last_input, process_hint, history_json
      from input_history
      order by updated_at desc;
    `);
    const rows = stmt.all() as Array<{
      session_id: string;
      last_input: string | null;
      process_hint: string | null;
      history_json: string;
    }>;
    const result: Record<string, InputMeta> = {};
    for (const r of rows) {
      let history: InputHistoryEntry[] = [];
      try {
        const parsed = JSON.parse(r.history_json);
        if (Array.isArray(parsed)) {
          history = parsed.filter(
            (x: any) => x && typeof x.text === "string" && x.text.trim().length > 0,
          );
        }
      } catch {
        // ignore
      }
      result[r.session_id] = {
        ...(r.last_input ? { lastInput: r.last_input } : {}),
        ...(r.process_hint ? { processHint: r.process_hint } : {}),
        history,
      };
    }
    return result;
  }

  deleteInputHistory(sessionId: string): void {
    this.db.prepare(`delete from input_history where session_id = ?;`).run(sessionId);
  }

  getPreference<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`select value_json from preferences where key = ?;`).get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setPreference(key: string, value: unknown): void {
    this.db.prepare(`
      insert into preferences (key, value_json, updated_at)
      values (@key, @value_json, @updated_at)
      on conflict(key) do update set
        value_json=excluded.value_json,
        updated_at=excluded.updated_at;
    `).run({
      key,
      value_json: JSON.stringify(value),
      updated_at: Date.now(),
    });
  }

  private parseArgsJson(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map(String);
    } catch {
      return [];
    }
  }
}
