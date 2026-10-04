// The service owns its exit. Nothing underneath it does: nitro 3 wires no
// close hook, srvx's signal handler closes the listener and returns, and
// graphile-worker's drains its pool and re-raises a signal nobody is left to
// act on — so a signalled service kept every handle open until `jigs service
// stop` gave up and killed it.

type Closer = () => Promise<void> | void;
type ShutdownPhase = "quiesce" | "close";

export interface ShutdownRegistration {
  phase?: ShutdownPhase;
}

export interface ShutdownDeps {
  signals?: Pick<NodeJS.EventEmitter, "on" | "listeners">;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
  backstopMs?: number;
}

// Under the CLI's ten-second stop timeout: a closer that hangs becomes an
// exit(1) with a line in the log, not a SIGKILL the operator has to read about.
export const SHUTDOWN_BACKSTOP_MS = 8_000;
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export interface Shutdown {
  onShutdown(closer: Closer, registration?: ShutdownRegistration): void;
  install(deps?: ShutdownDeps): void;
}

export function createShutdown(): Shutdown {
  const quiescers: Closer[] = [];
  const closers: Closer[] = [];
  let installed = false;
  let shuttingDown = false;

  async function run(signal: NodeJS.Signals, deps: ShutdownDeps) {
    const log = deps.log ?? ((line: string) => console.log(line));
    const error = deps.error ?? ((line: string) => console.error(line));
    const exit = deps.exit ?? process.exit;
    if (shuttingDown) {
      log(`[service] ${signal} ignored: already shutting down`);
      return;
    }
    shuttingDown = true;
    log(`[service] ${signal} received, shutting down`);
    const backstopMs = deps.backstopMs ?? SHUTDOWN_BACKSTOP_MS;
    const backstop = setTimeout(() => {
      error(`[service] shutdown still running after ${backstopMs}ms — exiting`);
      exit(1);
    }, backstopMs);
    backstop.unref();

    const runClosers = (registered: Closer[]) =>
      Promise.all(
        registered.map(async (closer) => {
          try {
            await closer();
          } catch (err) {
            error(
              `[service] shutdown step failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }),
      );
    // Quiescers stop admitting work and drain operations that still need the
    // World. Only after they settle may ordinary closers tear dependencies down.
    await runClosers(quiescers);
    await runClosers(closers);
    clearTimeout(backstop);
    exit(0);
  }

  return {
    onShutdown(closer, registration = {}) {
      (registration.phase === "quiesce" ? quiescers : closers).push(closer);
    },
    // `on`, not `once`: node restores the default disposition when the last
    // listener goes, so a `once` handler already removed leaves a second
    // SIGTERM mid-drain free to kill the process. Repeats hit the guard above.
    install(deps = {}) {
      if (installed) return;
      installed = true;
      const signals = deps.signals ?? process;
      for (const signal of SIGNALS) {
        signals.on(signal, () => void run(signal, deps));
      }
    },
  };
}

// One registry for the process: nitro runs the plugins that register closers
// without awaiting them and in no order this module can rely on, so a closer
// may land before or after the handlers are installed.
const shutdown = createShutdown();
export const onShutdown: Shutdown["onShutdown"] = shutdown.onShutdown;
export const installShutdown: Shutdown["install"] = shutdown.install;
