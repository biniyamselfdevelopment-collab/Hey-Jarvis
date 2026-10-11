import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol.js";

describe("protocol", () => {
  it("decodes valid host messages", () => {
    expect(decode('{"type":"utterance","id":"1","text":"hi","source":"voice"}')).toEqual({
      type: "utterance",
      id: "1",
      text: "hi",
      source: "voice",
    });
    expect(decode('{"type":"cancel"}')).toEqual({ type: "cancel" });
  });
  it("returns null for junk instead of throwing", () => {
    expect(decode("")).toBeNull();
    expect(decode("not json")).toBeNull();
    expect(decode('{"type":"launch_missiles"}')).toBeNull();
  });
  it("encodes one message per line", () => {
    expect(encode({ type: "state", state: "idle" })).toBe('{"type":"state","state":"idle"}\n');
  });
});
