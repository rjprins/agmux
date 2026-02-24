import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Task,
  TaskFilter,
  TaskInput,
  TaskLink,
  TaskLinkType,
  TaskPriority,
  TaskProvider,
  TaskProviderCapabilities,
  TaskStatus,
  TaskUpdate,
} from "../types.js";

const execFileAsync = promisify(execFile);

/** Raw JSON shape returned by `bd show --json`. */
interface BeadsIssue {
  id: string;
  title: string;
  body?: string;
  status: string;
  priority: number;
  links?: Array<{ type: string; target: string }>;
}

function toStatus(s: string): TaskStatus {
  if (s === "in-progress") return "in-progress";
  if (s === "closed") return "closed";
  return "open";
}

function toPriority(p: number): TaskPriority {
  if (p >= 0 && p <= 4) return p as TaskPriority;
  return 2;
}

function toLinkType(t: string): TaskLinkType | null {
  if (t === "blocks" || t === "related" || t === "parent") return t;
  return null;
}

function parseIssue(raw: BeadsIssue): Task {
  const links: TaskLink[] = [];
  for (const l of raw.links ?? []) {
    const type = toLinkType(l.type);
    if (type) links.push({ type, targetId: l.target });
  }
  return {
    id: raw.id,
    title: raw.title,
    description: raw.body ?? "",
    status: toStatus(raw.status),
    priority: toPriority(raw.priority),
    links,
  };
}

export class BeadsProvider implements TaskProvider {
  readonly name = "beads";
  readonly capabilities: TaskProviderCapabilities = {
    priorities: true,
    links: true,
    ready: true,
  };

  private bin: string;
  private cwd: string | undefined;

  constructor(options?: Record<string, unknown>) {
    this.bin = (options?.bin as string) ?? "bd";
    this.cwd = options?.cwd as string | undefined;
  }

  private async exec(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, args, {
      cwd: this.cwd,
      timeout: 10_000,
    });
    return stdout;
  }

  async create(input: TaskInput): Promise<Task> {
    const args = ["new", "--json", input.title];
    if (input.description) args.push("--body", input.description);
    if (input.priority !== undefined) args.push("--priority", String(input.priority));
    if (input.status && input.status !== "open") args.push("--status", input.status);

    const out = await this.exec(args);
    return parseIssue(JSON.parse(out));
  }

  async get(id: string): Promise<Task | null> {
    try {
      const out = await this.exec(["show", "--json", id]);
      return parseIssue(JSON.parse(out));
    } catch {
      return null;
    }
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const args = ["list", "--json"];

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const s of statuses) args.push("--status", s);
    }
    if (filter?.priority) {
      const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
      for (const p of priorities) args.push("--priority", String(p));
    }
    if (filter?.ready) {
      // `bd ready` returns only unblocked, open tasks sorted by priority
      const out = await this.exec(["ready", "--json"]);
      return (JSON.parse(out) as BeadsIssue[]).map(parseIssue);
    }

    const out = await this.exec(args);
    return (JSON.parse(out) as BeadsIssue[]).map(parseIssue);
  }

  async update(id: string, changes: TaskUpdate): Promise<Task> {
    const args = ["edit", id];
    if (changes.title) args.push("--title", changes.title);
    if (changes.description) args.push("--body", changes.description);
    if (changes.status) args.push("--status", changes.status);
    if (changes.priority !== undefined) args.push("--priority", String(changes.priority));
    await this.exec(args);

    if (changes.addLinks) {
      for (const link of changes.addLinks) {
        await this.exec(["link", id, link.type, link.targetId]);
      }
    }
    if (changes.removeLinks) {
      for (const link of changes.removeLinks) {
        await this.exec(["unlink", id, link.type, link.targetId]);
      }
    }

    const task = await this.get(id);
    if (!task) throw new Error(`Task ${id} not found after update`);
    return task;
  }

  async delete(id: string): Promise<void> {
    await this.exec(["close", id]);
  }

  async transition(id: string, status: TaskStatus): Promise<Task> {
    return this.update(id, { status });
  }
}
