/**
 * Letting go of what a session's tools were holding.
 *
 * ## Why this is not simply `closeBrowserSession`
 *
 * The gateway knows when a session ends. The *tools* know what a session was
 * holding. Neither should know the other's business: a gateway that imports
 * `@sqcode/tools` to close a browser will, the next time something needs
 * releasing, import it to close that too — and the list of things a session
 * holds is exactly the kind of list that goes stale when it lives at the call
 * site rather than beside the thing it describes.
 *
 * So the gateway asks for a session's resources to be released, and this is
 * the one place that knows what those are.
 *
 * ## What it cost to not have this
 *
 * Nothing ever called it. A Chromium is 150–300 MB and its own process tree,
 * and one was kept per session for the life of the gateway — alongside a
 * console-log array that grew for as long as the page stayed open. Deleting a
 * pile of old sessions was what finally aborted the process with an
 * out-of-memory error, which is a fitting way for it to surface: the moment
 * the resources were most certainly not needed.
 */

import { closeBrowserSession } from "@sqcode/tools";

/**
 * Release everything this session's tools were holding.
 *
 * Never throws and never blocks anything important: a browser that will not
 * close is a leak this call was trying to prevent, not a reason to fail the
 * request that triggered it.
 */
export async function releaseSessionResources(sessionId: string): Promise<void> {
  await closeBrowserSession(sessionId).catch(() => undefined);
}

/** Everything, for a process that is shutting down. */
export async function releaseAllSessionResources(): Promise<void> {
  await closeBrowserSession().catch(() => undefined);
}
