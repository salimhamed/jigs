// The allowlist predicate, in one place because it is applied in two: at the
// socket, to decide whether a message is answered at all, and again over a
// thread's history, because a thread anyone can read is a thread anyone can
// write into — and an unlisted author's words are not something this factory's
// model gets to act on.

export function isAllowedSpeaker(
  user: unknown,
  allowedUsers: readonly string[],
): boolean {
  return typeof user === "string" && allowedUsers.includes(user);
}
