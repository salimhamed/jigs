// An inactive trigger or schedule is neither run nor checked: the service and doctor see only these.

import type { Factory } from "../workflow/factory.ts";

const active = <T extends { active: boolean }>(entries: Record<string, T> = {}) =>
  Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.active));

/** The factory with only its active triggers and schedules. */
export function activeFactory(factory: Factory): Factory {
  return {
    ...factory,
    schedules: active(factory.schedules),
    triggers: active(factory.triggers),
  };
}
