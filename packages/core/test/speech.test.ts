import { describe, expect, it } from "vitest";
import { SentenceStream, toSpeech } from "../src/speech.js";

describe("toSpeech", () => {
  it("strips markdown, code and URLs", () => {
    expect(toSpeech("## Result\n- **Done**: see [the docs](https://x.dev) or https://y.dev/z\n```js\nx()\n```")).toBe(
      "Result Done: see the docs or the link",
    );
    expect(toSpeech("Run `npm test` now.")).toBe("Run npm test now.");
  });
});

describe("SentenceStream", () => {
  const collect = (minChars?: number) => {
    const out: string[] = [];
    return { out, stream: new SentenceStream((s) => out.push(s), minChars) };
  };

  it("emits whole sentences as soon as they complete", () => {
    const { out, stream } = collect();
    for (const piece of ["It's 22 degr", "ees in Addis. Perfect walk", "ing weather! Anything else?"]) stream.push(piece);
    expect(out).toEqual(["It's 22 degrees in Addis.", "Perfect walking weather!"]);
    stream.flush();
    expect(out.at(-1)).toBe("Anything else?");
    expect(stream.spoke).toBe(true);
  });

  it("does not split decimals or merge-worthy short bits", () => {
    const { out, stream } = collect(20);
    stream.push("Sure. Version 3.5 is out now. ");
    expect(out).toEqual(["Sure. Version 3.5 is out now."]);
  });

  it("waits for code blocks to close and drops them", () => {
    const { out, stream } = collect(5);
    stream.push("Here it is.\n```\nprint('a. b. c.')\n");
    expect(out).toEqual(["Here it is."]);
    stream.push("```\nDone now.");
    stream.flush();
    expect(out).toEqual(["Here it is.", "Done now."]);
  });

  it("reports nothing spoken for empty output", () => {
    const { stream } = collect();
    stream.push("  ");
    stream.flush();
    expect(stream.spoke).toBe(false);
  });
});
