import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import type { Project, Settings } from "../model.ts";
import type { Store } from "../runner.ts";
import { importConfig } from "../server.ts";
import { fixtureProjects, fixtureSettings } from "./fixtures/projects.ts";

class MemStore implements Store {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix ?? ""));
  }
}

describe("importConfig", () => {
  it("stores fixture projects and settings into an empty store", async () => {
    const store = new MemStore();
    const result = await importConfig(store, {
      projects: fixtureProjects(),
      settings: fixtureSettings(),
    });
    expect(result.imported).toEqual(["alpha", "beta"]);
    const projects = (await store.get<Project[]>("projects"))!;
    expect(projects.map((p) => p.id)).toEqual(["alpha", "beta"]);
    const settings = (await store.get<Settings>("settings"))!;
    expect(settings).toEqual(fixtureSettings());
  });

  it("re-importing a changed alpha keeps beta", async () => {
    const store = new MemStore();
    await importConfig(store, {
      projects: fixtureProjects(),
      settings: fixtureSettings(),
    });
    const alpha = { ...fixtureProjects()[0], title: "alpha-renamed" };
    const result = await importConfig(store, { projects: [alpha] });
    expect(result.imported).toEqual(["alpha"]);
    const projects = (await store.get<Project[]>("projects"))!;
    expect(projects.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(projects.find((p) => p.id === "alpha")!.title).toBe("alpha-renamed");
    expect(projects.find((p) => p.id === "beta")!.site).toBe("beta.example");
  });

  it("a project without hostId throws and the store is left unchanged", async () => {
    const store = new MemStore();
    await importConfig(store, {
      projects: fixtureProjects(),
      settings: fixtureSettings(),
    });
    const beforeProjects = structuredClone((await store.get("projects"))!);
    const beforeSettings = structuredClone((await store.get("settings"))!);
    const bad = { ...fixtureProjects()[0] };
    delete (bad as { hostId?: string }).hostId;
    await expect(importConfig(store, { projects: [bad] })).rejects.toBeInstanceOf(ZodError);
    expect(await store.get("projects")).toEqual(beforeProjects);
    expect(await store.get("settings")).toEqual(beforeSettings);
  });
});
