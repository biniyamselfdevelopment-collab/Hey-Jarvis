import { describe, expect, it } from "vitest";
import { decide, parseConfirmation, PermissionGate } from "../src/permissions.js";
import type { CoreMessage } from "../src/protocol.js";

describe("parseConfirmation", () => {
  it.each(["Yes", "yeah go ahead", "Sure, do it.", "okay", "post it!", "Yep, send it"])("%s → yes", (t) => {
    expect(parseConfirmation(t)).toBe("yes");
  });
  it.each(["no", "Nope.", "cancel that", "wait", "hold on a sec", "don't", "never mind", "not now"])("%s → no", (t) => {
    expect(parseConfirmation(t)).toBe("no");
  });
  it("lets a negative override a positive", () => {
    expect(parseConfirmation("yes— wait, no")).toBe("no");
    expect(parseConfirmation("okay don't post it")).toBe("no");
  });
  it.each(["what's the weather", "hmm", ""])("%s → unclear", (t) => {
    expect(parseConfirmation(t)).toBe("unclear");
  });
  it("does not mistake 'now' for 'no'", () => {
    expect(parseConfirmation("yes do it now")).toBe("yes");
  });
});

describe("decide", () => {
  it("confirms only high risk by default", () => {
    expect(decide("low")).toBe("run");
    expect(decide("medium")).toBe("run");
    expect(decide("high")).toBe("confirm");
  });
  it("respects per-tool overrides", () => {
    expect(decide("high", "allow")).toBe("run");
    expect(decide("low", "ask")).toBe("confirm");
    expect(decide("low", "deny")).toBe("deny");
  });
});

describe("PermissionGate", () => {
  const setup = () => {
    const sent: CoreMessage[] = [];
    return { sent, gate: new PermissionGate((m) => sent.push(m)) };
  };

  it("approves by voice and announces the request", async () => {
    const { sent, gate } = setup();
    const p = gate.request("post", "I'll post 'hello' to X.");
    expect(sent).toContainEqual({ type: "speak", text: "I'll post 'hello' to X. Should I go ahead?", expectReply: true });
    expect(gate.handleUtterance("yes go ahead")).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(gate.waiting).toBe(false);
  });

  it("re-asks once on an unclear answer, then cancels", async () => {
    const { sent, gate } = setup();
    const p = gate.request("post", "Post it.");
    gate.handleUtterance("umm what");
    expect(gate.waiting).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "speak", text: "Sorry, was that a yes or a no?", expectReply: true });
    gate.handleUtterance("banana");
    await expect(p).resolves.toBe(false);
  });

  it("accepts a click response only for the matching request", async () => {
    const { sent, gate } = setup();
    const p = gate.request("shell", "Run ls.");
    const req = sent.find((m) => m.type === "confirm_request");
    gate.handleResponse("someone-else", true);
    expect(gate.waiting).toBe(true);
    gate.handleResponse(req && "requestId" in req ? req.requestId : "", true);
    await expect(p).resolves.toBe(true);
  });

  it("ignores utterances when nothing is pending", () => {
    expect(setup().gate.handleUtterance("yes")).toBe(false);
  });
});
