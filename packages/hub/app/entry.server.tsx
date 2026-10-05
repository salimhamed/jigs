import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import {
  type EntryContext,
  type HandleErrorFunction,
  isRouteErrorResponse,
  ServerRouter,
} from "react-router";

export const streamTimeout = 5_000;

// React Router's default handler logs a stack trace for every page not found.
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted || (isRouteErrorResponse(error) && error.status === 404)) return;
  // A route error response keeps the real error it wraps, with its stack, privately.
  const cause = isRouteErrorResponse(error) && (error as { error?: unknown }).error;
  console.error(cause || error);
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");
    const readyOption = userAgent && isbot(userAgent) ? "onAllReady" : "onShellReady";
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          responseHeaders.set("Content-Type", "text/html");
          pipe(body);
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // A shell error rejects above and React Router logs it.
          if (shellRendered) console.error(error);
        },
      },
    );
  });
}
