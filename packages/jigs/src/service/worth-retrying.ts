import { GitHubApiError } from "../providers/github-http.ts";
import { HubResponseError } from "../providers/hub.ts";

/**
 * Whether routing a provider event again could end differently after this
 * error. Not when the hub does not give this factory the installation, or when
 * GitHub refused the request itself rather than its credential or its rate
 * limit: those answer the same every time.
 */
export function worthRetrying(error: unknown): boolean {
  if (error instanceof HubResponseError) return error.status !== 404;
  if (error instanceof GitHubApiError)
    return (
      error.rateLimited ||
      error.status < 400 ||
      error.status >= 500 ||
      error.status === 401 ||
      error.status === 429
    );
  return true;
}
