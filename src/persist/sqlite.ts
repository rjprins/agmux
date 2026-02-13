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
    `);
  }

  upsertSession(summary: PtySummary): void {
    const stmt = this.db.prepare(`
      insert into sessions (
        id, name, command, args_json, cwd, created_at, last_seen_at, status, exit_code, exit_signal
      ) values (
        @id, @name, @command, @args_json, @cwd, @created_at, @last_seen_at, @status, @exit_code, @exit_signal
      )
      on conflict(id) do update set
        name=excluded.name,
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
      select id, name, command, args_json, cwd, created_at, status, exit_code, exit_signal
      from sessions
      order by created_at desc
      limit ?;
    `);
    const rows = stmt.all(limit) as Array<{
      id: string;
      name: string;
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
      command: r.command,
      args: JSON.parse(r.args_json) as string[],
      cwd: r.cwd,
      createdAt: r.created_at,
      status: r.status === "running" ? "running" : "exited",
      exitCode: r.exit_code,
      exitSignal: r.exit_signal,
    }));
  }
}
