/**
 * Time as an injected capability.
 *
 * Timestamps land in genome versions and run artifacts, both of which are
 * content-addressed. If stage code reads the wall clock directly, two otherwise
 * identical runs hash differently and reproducibility is lost. Stages take a
 * Clock instead; tests inject a fixed one.
 */
export interface Clock {
  now(): Date;
  /** Milliseconds since an arbitrary origin, for measuring durations. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

/** A clock that advances only when told to. */
export class FixedClock implements Clock {
  #current: number;
  #monotonic = 0;

  constructor(start: Date | string = "2025-01-01T00:00:00.000Z") {
    this.#current = typeof start === "string" ? Date.parse(start) : start.getTime();
  }

  now(): Date {
    return new Date(this.#current);
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  /** Advance both wall and monotonic time by `ms`. */
  advance(ms: number): void {
    this.#current += ms;
    this.#monotonic += ms;
  }
}
