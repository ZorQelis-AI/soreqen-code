/**
 * What a tidy pass asks of the agent: the same job as Claude's
 * consolidate-memory, run on request (`/memory tidy` in the CLI and in the
 * app's chat box). Here, not in the orchestrator, because the app's screen
 * sends it and cannot import Node code.
 */
export const MEMORY_TIDY_PROMPT = [
  "Tidy your memory. Work only on memory (remember, edit_memory, forget, recall); change no project file.",
  "1. Read every memory listed in your MEMORY section, with recall for any shown without its content.",
  "2. Merge memories about the same subject into one (rewrite one with remember, forget the rest).",
  "3. Fix what is stale or wrong. Where a memory names a file, path, command or host you can check cheaply from here, check it; forget what is no longer true.",
  "4. Remove progress, status and logs of past work: keep what a future session acts on.",
  "5. Link related memories with [[their-name]] where it helps.",
  "Then reply with a short list of what you merged, fixed, linked and forgot, or that nothing needed changing.",
].join("\n");
