import {
  experimental_defineHostEntry,
  defineRpcContract,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const SLUG = /^[A-Za-z0-9_-]{1,80}$/;

export const hostContract = defineRpcContract({
  start: {
    input: z.object({
      runId: z.string().regex(SLUG),
      cwd: z.string(),
      script: z.string(),
    }),
    output: z.object({ pid: z.number() }),
  },
  status: {
    input: z.object({ runId: z.string().regex(SLUG) }),
    output: z.object({
      alive: z.boolean(),
      exitCode: z.number().optional(),
      stages: z.array(z.record(z.string(), z.unknown())),
    }),
  },
  tail: {
    input: z.object({
      runId: z.string().regex(SLUG),
      stageId: z.string().regex(SLUG),
      lines: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({ out: z.string(), err: z.string() }),
  },
  notify: {
    input: z.object({ command: z.string(), text: z.string() }),
    output: z.object({ exitCode: z.number() }),
  },
});

const runDir = (runId: string): string =>
  path.join(os.homedir(), ".direct-queries", "runs", runId);

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    start: async ({ runId, cwd, script }) => {
      if (!path.isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new Error("cwdInvalid");
      }
      const dir = runDir(runId);
      mkdirSync(dir, { recursive: true });
      const jobSh = path.join(dir, "job.sh");
      writeFileSync(jobSh, script, { mode: 0o755 });
      const out = openSync(path.join(dir, "job.out"), "a");
      const err = openSync(path.join(dir, "job.err"), "a");
      const child = spawn("/bin/sh", [jobSh], {
        cwd,
        detached: true,
        stdio: ["ignore", out, err],
      });
      child.unref();
      writeFileSync(path.join(dir, "pid"), String(child.pid));
      return { pid: child.pid ?? 0 };
    },

    status: async ({ runId }) => {
      const dir = runDir(runId);
      let alive = false;
      const pidText = readText(path.join(dir, "pid"));
      if (pidText !== undefined) {
        const pid = Number(pidText.trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        }
      }
      const exitText = readText(path.join(dir, "exit"));
      const exitCode = exitText !== undefined ? Number(exitText.trim()) : NaN;
      const stages: Record<string, unknown>[] = [];
      const jsonl = readText(path.join(dir, "stages.jsonl"));
      if (jsonl !== undefined) {
        for (const line of jsonl.split("\n")) {
          if (!line.trim()) continue;
          try {
            stages.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // skip bad lines
          }
        }
      }
      return {
        alive,
        ...(Number.isFinite(exitCode) ? { exitCode } : {}),
        stages,
      };
    },

    tail: async ({ runId, stageId, lines }) => {
      const dir = runDir(runId);
      const take = (file: string): string => {
        const text = readText(path.join(dir, file));
        if (text === undefined) return "";
        const all = text.split("\n");
        if (all.length > 0 && all[all.length - 1] === "") all.pop();
        return all.slice(-lines).join("\n");
      };
      return { out: take(`${stageId}.out`), err: take(`${stageId}.err`) };
    },

    notify: async ({ command, text }) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "dq-notify-"));
      const file = path.join(dir, "message.md");
      writeFileSync(file, text);
      const cmd = command.replaceAll("{file}", sq(file));
      const exitCode = await new Promise<number>((resolve) => {
        execFile("/bin/sh", ["-c", cmd], { timeout: 60000 }, (err) => {
          resolve(err === null ? 0 : typeof err.code === "number" ? err.code : 1);
        });
      });
      return { exitCode };
    },
  },
});
