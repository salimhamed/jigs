/**
 * The two roles a member of an Organization holds: admins manage apps,
 * factories and members; members see everything and connect factories to apps.
 */
export const roles = ["admin", "member"] as const;
export type Role = (typeof roles)[number];
