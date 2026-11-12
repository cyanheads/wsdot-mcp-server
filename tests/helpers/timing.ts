/**
 * @fileoverview The suite's one growth check for code that reads caller- or upstream-sized text:
 * thread-CPU time measured across a 64× span of input sizes, so every linear-time guarantee is
 * held to the same bar.
 * @module tests/helpers/timing
 */

import { expect } from 'vitest';

/**
 * Least thread-CPU milliseconds per call of `run`: the fastest of three samples, each a batch of
 * calls long enough to clear the scheduler tick. Thread CPU charges only this thread's work, not
 * time spent waiting on another suite's worker.
 */
function cpuMsPerCall(run: () => unknown): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let elapsedMs = 0;
    do {
      run();
      calls++;
      const used = process.threadCpuUsage(start);
      elapsedMs = (used.user + used.system) / 1_000;
    } while (elapsedMs < 5);
    least = Math.min(least, elapsedMs / calls);
  }
  return least;
}

/**
 * Asserts `run` grows sub-quadratically from 5,000 to 320,000 characters, doubling the input and
 * checking each size before building the next. At every size the 5,000-character baseline is
 * timed again beside it, and the least of three size/baseline ratios stays under four times the
 * size factor: 256 across the full 64× span, where linear cost reads about 64 and quadratic about
 * 4,096. Each size's call also stays under `maxMs` of thread CPU.
 *
 * The body is synchronous, so call it from a test whose timeout is `0`: a loaded lane then fails on
 * growth, never on the clock.
 */
export function expectSubQuadratic(
  build: (chars: number) => string,
  run: (input: string) => unknown,
  maxMs = 250,
): void {
  const baseline = build(5_000);
  run(baseline);
  for (let factor = 2; factor <= 64; factor *= 2) {
    const input = build(5_000 * factor);
    run(input);
    let growth = Number.POSITIVE_INFINITY;
    let inputMs = 0;
    for (let pair = 0; pair < 3; pair++) {
      const baselineMs = cpuMsPerCall(() => run(baseline));
      inputMs = cpuMsPerCall(() => run(input));
      growth = Math.min(growth, inputMs / baselineMs);
    }
    expect(growth, `${input.length} characters`).toBeLessThan(4 * factor);
    expect(inputMs, `${input.length} characters`).toBeLessThan(maxMs);
  }
}
