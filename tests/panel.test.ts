import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en, ru } from "../i18n.ts";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("panel release", () => {
  it("package.json shows «Панель Яндекс Директ» at version 0.4.0", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.bb.name).toBe("Панель Яндекс Директ");
    expect(pkg.version).toBe("0.4.0");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe("0.4.0");
    expect(lock.packages[""].version).toBe("0.4.0");
  });

  it("i18n titles name the panel in both locales", () => {
    expect(ru.title).toBe("Панель Яндекс Директ");
    expect(en.title).toBe("Yandex Direct Panel");
  });

  it("direct-panel skill exists and documents every CLI subcommand", () => {
    const skill = read("skills/direct-panel/SKILL.md");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(frontmatter).toContain("name: direct-panel");
    const server = read("server.ts");
    const subs = new Set<string>();
    for (const m of server.matchAll(/bb direct-queries ([a-z][a-z-]*)/g)) {
      subs.add(m[1]);
    }
    expect(subs.size).toBeGreaterThan(0);
    for (const sub of subs) {
      expect(skill).toContain(`bb direct-queries ${sub}`);
    }
  });

  it(".gitignore excludes Claude Code local files", () => {
    const lines = read(".gitignore").split("\n");
    expect(lines).toContain(".claude/");
    expect(lines).toContain("CLAUDE.md");
  });
});
