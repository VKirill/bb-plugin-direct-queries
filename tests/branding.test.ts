import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const ARROW_START = "M16.73 39.73";

describe("branding assets", () => {
  it("icon.svg is a single-colour mask without embedded raster or hex colours", () => {
    const icon = read("assets/icon.svg");
    expect(icon).not.toContain("<image");
    expect(icon).not.toContain("data:");
    expect(icon).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(icon).toContain('fill-rule="evenodd"');
    expect(icon).toContain("currentColor");
    expect(icon).toContain(ARROW_START);
  });

  it("logo.svg is the official colour logo", () => {
    const logo = read("assets/logo.svg");
    expect(logo).toContain("#1A4A7F");
    expect(logo).toContain("#FFB800");
    expect(logo).toContain(ARROW_START);
  });

  it("logo-dark.svg has the same content as logo.svg", () => {
    expect(read("assets/logo-dark.svg")).toBe(read("assets/logo.svg"));
  });

  it("package.json points bb.branding at the icon and light/dark logos", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.bb.branding.icon).toBe("./assets/icon.svg");
    expect(pkg.bb.branding.logo.light).toBe("./assets/logo.svg");
    expect(pkg.bb.branding.logo.dark).toBe("./assets/logo-dark.svg");
  });
});
