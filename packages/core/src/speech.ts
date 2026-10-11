/** Turning model text into something pleasant to hear, sentence by sentence. */

/** Strip markdown and other things that sound awful read aloud. */
export function toSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "") // headings, bullets
    .replace(/(\*\*|__|\*|_|~~)(\S[^]*?\S|\S)\1/g, "$2") // emphasis
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Buffers streamed text and emits whole sentences, so TTS can start on the
 * first sentence while the model is still writing the rest.
 */
export class SentenceStream {
  private buffer = "";
  spoke = false;

  constructor(
    private readonly say: (sentence: string) => void,
    private readonly minChars = 20,
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const end = this.boundary();
      if (end < 0) return;
      const sentence = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.emit(sentence);
    }
  }

  flush(): void {
    this.emit(this.buffer);
    this.buffer = "";
  }

  /** Index just past the first sentence that is long enough to say on its own. */
  private boundary(): number {
    // Never cut inside a code block (closed, or still streaming).
    const fences = [...this.buffer.matchAll(/```/g)].map((f) => f.index);
    const inCode = (i: number) => {
      for (let f = 0; f < fences.length; f += 2) {
        if (i >= fences[f]! && (f + 1 >= fences.length || i < fences[f + 1]! + 3)) return true;
      }
      return false;
    };
    const re = /[.!?…]+["')\]]*\s+|\n+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buffer))) {
      const end = m.index + m[0].length;
      if (inCode(m.index)) continue;
      if (this.buffer.slice(0, end).trim().length >= this.minChars) return end;
    }
    return -1;
  }

  private emit(text: string): void {
    const spoken = toSpeech(text);
    if (!spoken) return;
    this.spoke = true;
    this.say(spoken);
  }
}
