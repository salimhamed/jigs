/** The two roles a member of an Organization holds: admins manage, members view. */
export const roles = ["admin", "member"] as const;
export type Role = (typeof roles)[number];
