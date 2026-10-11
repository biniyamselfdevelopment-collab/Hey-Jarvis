export interface TurnIO {
  signal: AbortSignal;
  /** Speak a sentence now (streamed speech). */
  say: (text: string) => void;
}

export interface TurnResult {
  /** The final answer text. */
  text: string;
  /** True if the brain already spoke the answer through `io.say`. */
  spoke: boolean;
}

/** Something that can think: Jarvis's own AI SDK loop, or a delegate like OpenCode. */
export interface Brain {
  readonly label: string;
  turn(text: string, io: TurnIO): Promise<TurnResult>;
  close?(): Promise<void> | void;
}
