/**
 * The two roles a member of an Organization holds: admins manage apps,
 * members, settings and every factory; members see everything, and add and
 * manage their own factories.
 */
export const roles = ["admin", "member"] as const;
export type Role = (typeof roles)[number];
