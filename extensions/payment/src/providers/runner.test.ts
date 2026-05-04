import { describe, expect, it } from "vitest";
import { createLinkCliCommandRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// createLinkCliCommandRunner — structural tests
//
// The production runner is specialized for link-cli (the executable name is a
// string literal, required by ClawHub's isSafeLiteralExecFileCall carve-out).
// Because it always calls execFile("link-cli", ...) the command argument from
// the CommandRunner signature is intentionally ignored.
//
// Full behavioral coverage (timeout, EPIPE, stdin, signal) is exercised
// indirectly through the stripe-link adapter tests which inject a mock runner.
// ---------------------------------------------------------------------------

describe("createLinkCliCommandRunner — structural contract", () => {
  it("returns a function (the CommandRunner)", () => {
    const run = createLinkCliCommandRunner();
    expect(typeof run).toBe("function");
  });

  it("the returned function returns a Promise", () => {
    const run = createLinkCliCommandRunner();
    // link-cli is available in this env; just verify we get a Promise back.
    // We don't await — just check the shape.
    const result = run("link-cli", ["--version"]);
    expect(typeof result.then).toBe("function");
    // Clean up: let the process finish without awaiting it here.
    return result.then(() => void 0).catch(() => void 0);
  });

  it("ignores the command argument and always calls link-cli", async () => {
    const run = createLinkCliCommandRunner();
    // Even when "ignored-command" is passed, the runner calls link-cli.
    // link-cli --version exits cleanly, confirming link-cli was invoked.
    const result = await run("ignored-command", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/); // version string
  });
});
