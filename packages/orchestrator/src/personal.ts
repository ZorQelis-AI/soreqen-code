/**
 * Settings > General, in the system prompt: who the person is and how they
 * want the agent to work (asked for 13 Nov 2026).
 *
 * Their own words, typed into their own app, so trusted as the person's —
 * unlike a project's rulebook, which a stranger may have written. Read once
 * at the start of a turn with the rest of the prompt, so changing it never
 * rewrites the cached prefix of a turn under way.
 */

import type { PersonalSettings } from "./types.js";

/** Longest each part is sent: a profile is a few lines, instructions a page. */
const LIMITS = { name: 80, role: 160, about: 2_000, instructions: 8_000, replyLanguage: 60 } as const;

const clip = (text: string | undefined, max: number): string => (text ?? "").replace(/\r\n/g, "\n").trim().slice(0, max).trim();

export function personalSection(personal: PersonalSettings | undefined): string {
  if (!personal) return "";
  const name = clip(personal.name, LIMITS.name);
  const role = clip(personal.role, LIMITS.role);
  const about = clip(personal.about, LIMITS.about);
  const instructions = clip(personal.instructions, LIMITS.instructions);
  const language = clip(personal.replyLanguage, LIMITS.replyLanguage);
  if (!name && !role && !about && !instructions && !language) return "";

  const lines: string[] = ["## THE PERSON YOU WORK WITH (their own settings)"];
  const who = [name ? `Their name is ${name}.` : "", role ? `They describe what they do as: ${role}.` : ""].filter(Boolean).join(" ");
  if (who) lines.push(who);
  if (about) lines.push("", "What they want you to know about them:", about);
  if (language) lines.push("", `Write your replies to them in ${language}, whatever language the project or the tools use. Code, commands and file contents stay as they must be.`);
  if (instructions) {
    lines.push(
      "",
      "### Their standing instructions",
      "They wrote these for every session and every project. Follow them as you would the person saying them now; where one conflicts with what they ask in this conversation, the conversation wins. They do not override safety, or the permission tier.",
      "",
      instructions,
    );
  }
  return lines.join("\n");
}
