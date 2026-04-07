import { describe, expect, it } from "vitest";

import { isTransportConnectionErrorMessage, sanitizeWorkspaceErrorMessage } from "./transportError";

describe("transportError", () => {
  it("detects websocket transport failures", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: 1006")).toBe(true);
    expect(isTransportConnectionErrorMessage("Unable to connect to the T3 server WebSocket.")).toBe(
      true,
    );
    expect(isTransportConnectionErrorMessage("SocketOpenError: Timeout")).toBe(true);
  });

  it("preserves non-transport workspace errors", () => {
    expect(sanitizeWorkspaceErrorMessage("Turn failed")).toBe("Turn failed");
    expect(sanitizeWorkspaceErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("drops transport failures from workspace surfaces", () => {
    expect(sanitizeWorkspaceErrorMessage("SocketCloseError: 1006")).toBeNull();
  });
});
