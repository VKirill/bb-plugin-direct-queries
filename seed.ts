import type { Project, Settings } from "./model.ts";

/** Projects are imported with `bb direct-queries import <file.json>`. */
export function seedProjects(): Project[] {
  return [];
}

export function seedSettings(): Settings {
  return {
    morningLine: {
      enabled: false,
      hostId: "",
      hour: 9,
      command: "",
    },
    timeZone: "Europe/Moscow",
  };
}
