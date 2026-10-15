/**
 * Run `task` now, then `ms` after each run ends, until stopped. `stop`
 * resolves once a run under way ends. `task` handles its own errors.
 */
export function every(ms: number, task: () => Promise<void>): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void>;
  const run = () => {
    running = task().finally(() => {
      if (!stopped) timer = setTimeout(run, ms);
    });
  };
  run();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      return running;
    },
  };
}
