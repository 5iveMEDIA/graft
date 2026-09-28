/**
 * `graft trail pull`: one command for both things a trail hands this repo.
 *
 * First the rules, refreshed into graft's own blocks in the agent files (what
 * `graft trail pull` always did). Then every change accepted in Trail, for every
 * context file the picked agents read — the root CLAUDE.md (what `graft
 * claude-md pull` did, and still does, as an alias of this), and then AGENTS.md,
 * folder CLAUDE.md files, Cursor rules and skills when Trail serves them.
 *
 * Files for agents that were not picked are neither listed nor written.
 */
import { isAbsolute, relative } from "node:path";
import { connectBrain, type ConnectResult } from "./connect.js";
import { fetchAcceptedChanges, markApplied } from "./claude-md.js";
import {
  changeSummary,
  fetchContextFiles,
  kindForPath,
  markContextFilesApplied,
  planContextFile,
  readByWired,
  writePlannedFile,
  type ContextFile,
  type FilePlan,
} from "./context-files.js";
import type { BrainLink } from "./link.js";
import { reviewUrl } from "./signup.js";

export interface PullOptions {
  home: string;
  /** The agents this repo is wired for; empty means no choice was recorded. */
  wired: string[];
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
}

/** Repo-relative, forward slashes, for printing. */
function show(repo: string, path: string): string {
  const rel = isAbsolute(path) ? relative(repo, path) : path;
  return rel.split("\\").join("/");
}

/** The rules line: how many, and which files they are in. */
export function rulesLine(repo: string, res: ConnectResult): string | null {
  if (res.warning) return `⚠ ${res.warning}`;
  if (res.ruleCount === 0) return "· the trail has no rules yet — run graft trail push to read this repo into it";
  const n = res.ruleCount.toLocaleString("en-US");
  const where = res.writes.map((w) => show(repo, w.path)).join(", ");
  const rules = `${n} rule${res.ruleCount === 1 ? "" : "s"}`;
  if (!where) return `✓ ${rules} pulled · no instruction file to write them into — graft ask still carries them`;
  if (res.writes.every((w) => w.action === "unchanged")) return `✓ rules already current · ${n} in ${where}`;
  return `✓ ${rules} refreshed in ${where}`;
}

/** Everything the pull will write, file by file, with where each change came from. */
interface Planned {
  plan: FilePlan;
  source: "claude-md" | "context-files";
}

/**
 * Run the pull. Returns the exit code; every line goes through `write`.
 */
export async function runTrailPull(repo: string, link: BrainLink, opts: PullOptions): Promise<number> {
  const write = opts.write ?? ((l: string) => console.error(l));
  const fetchImpl = opts.fetchImpl ?? fetch;
  let code = 0;

  // 1. The rules. Skipped on a dry run, which writes nothing at all.
  if (!opts.dryRun) {
    const res = await connectBrain(repo, link, {
      home: opts.home,
      ids: opts.wired.length > 0 ? opts.wired : undefined,
      fetchImpl,
    });
    const line = rulesLine(repo, res);
    if (line) write(line);
    if (res.warning) code = 1;
  }

  // 2. Accepted changes: the root CLAUDE.md, then every other context file.
  const planned: Planned[] = [];
  let accepted = 0;

  const md = await fetchAcceptedChanges(link, fetchImpl);
  if ("error" in md) {
    if (!md.unsupported) {
      write(`✗ ${md.error}`);
      code = 1;
    }
  } else if (md.changes.length > 0) {
    const file: ContextFile = { kind: kindForPath(md.path || "CLAUDE.md"), path: md.path || "CLAUDE.md", changes: md.changes };
    if (readByWired(file.kind, opts.wired)) {
      accepted += file.changes.length;
      planned.push({ plan: planContextFile(repo, file), source: "claude-md" });
    }
  }

  const ctx = await fetchContextFiles(link, fetchImpl);
  if ("error" in ctx) {
    write(`✗ ${ctx.error}`);
    code = 1;
  } else if (!("unsupported" in ctx)) {
    for (const file of ctx.files) {
      if (file.changes.length === 0 || !readByWired(file.kind, opts.wired)) continue;
      accepted += file.changes.length;
      planned.push({ plan: planContextFile(repo, file), source: "context-files" });
    }
  }

  if (accepted === 0) {
    if (code === 0) {
      write("· nothing accepted in Trail yet — review:");
      write(`  ${reviewUrl(link.brainId)}`);
    }
    return code;
  }

  const writing = planned.filter((p) => p.plan.status);
  const changes = writing.reduce((n, p) => n + p.plan.written.length, 0);
  if (writing.length > 0) {
    write(`✓ ${opts.dryRun ? "would write" : "wrote"} ${changes} accepted change${changes === 1 ? "" : "s"}`);
    const width = Math.max(30, ...writing.map((p) => p.plan.path.length)) + 2;
    for (const { plan } of writing) {
      const summary = changeSummary(plan.written);
      write(`  ${plan.status} ${summary ? plan.path.padEnd(width) : plan.path}${summary}`.trimEnd());
    }
  } else if (planned.some((p) => p.plan.present.length > 0)) {
    write("✓ every accepted change is already in these files");
  }

  for (const { plan } of planned) {
    for (const s of plan.skipped) {
      const what = s.change.kind === "edit" || s.change.kind === "add" ? `${changeSummary([s.change])} in ${plan.path}` : plan.path;
      write(`⚠ skipped ${what} — ${s.why}; edit it in Trail, then pull again`);
      code = 1;
    }
  }

  if (opts.dryRun) {
    write("· dry run — nothing written, and Trail was not told");
    return code;
  }

  for (const { plan } of writing) {
    try {
      writePlannedFile(repo, plan);
    } catch (e) {
      write(`✗ could not write ${plan.path}: ${e instanceof Error ? e.message : e}`);
      // Nothing from a file that was not written is reported as applied.
      plan.written = [];
      plan.present = [];
      code = 1;
    }
  }

  // Written now or already there: either way Trail should stop listing it.
  const done = (source: Planned["source"]) =>
    planned.filter((p) => p.source === source).flatMap((p) => [...p.plan.written, ...p.plan.present].map((c) => c.id));
  const told = (await markApplied(link, done("claude-md"), fetchImpl)) && (await markContextFilesApplied(link, done("context-files"), fetchImpl));
  if (!told) write("⚠ could not tell Trail which changes were written; it may still list them");
  if (writing.length > 0) write("· review with git diff, then commit");
  return code;
}
