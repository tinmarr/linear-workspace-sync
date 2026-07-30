import { describe, expect, it, vi } from "vitest";
import { logError, logEvent } from "../src/log.js";

describe("logging", () => {
  it("writes structured events to stdout", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logEvent("test_event", { workspace: "personal" });

    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({
      level: "info",
      event: "test_event",
      workspace: "personal",
    });
    output.mockRestore();
  });

  it("writes errors to stdout without exposing an error object", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logError("test_failure", new Error("expected failure"), { workspace: "personal" });

    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({
      level: "error",
      event: "test_failure",
      error: "expected failure",
      workspace: "personal",
    });
    output.mockRestore();
  });
});
