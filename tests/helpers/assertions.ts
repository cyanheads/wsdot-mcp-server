/**
 * @fileoverview Narrowing helpers shared by the test suite. Each one turns a value the type
 * system reports as possibly-absent — an indexed element, the text of a content block, the
 * error a handler threw — into the concrete value an assertion needs, and throws with a
 * specific message when it isn't there. Narrowing by checking rather than by assertion keeps
 * a fixture that lost its subject failing on the missing subject instead of on a downstream
 * property read, and keeps `noUncheckedIndexedAccess` in force across `tests/`.
 * @module tests/helpers/assertions
 */

/**
 * Returns `items[index]`, throwing when the element is absent.
 *
 * @param items - Collection to read from.
 * @param index - Zero-based position; defaults to the first element.
 */
export function nth<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an element at index ${index}, but the array holds ${items.length}.`);
  }
  return item;
}

/**
 * Returns the text a definition's `format()` rendered into the block at `index`. Only the text
 * variant of an SDK content block carries a `text` field, so anything else is a formatter
 * defect rather than a value to tolerate. The parameter is typed structurally so the suite
 * takes no direct dependency on the MCP SDK, which the server carries only transitively.
 *
 * @param blocks - Blocks returned by a definition's `format()`.
 * @param index - Zero-based position; defaults to the first block.
 */
export function formattedText(blocks: readonly { type: string }[], index = 0): string {
  const block = nth(blocks, index);
  if (block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') {
    throw new Error(`Expected a text content block at index ${index}, received "${block.type}".`);
  }
  return block.text;
}

/**
 * Runs `call` and resolves to the error it threw, failing when it returns instead. Handlers
 * are declared to return either a value or a promise, so the call is wrapped rather than
 * chained off an assumed promise.
 *
 * @param call - Invocation expected to reject or throw.
 */
export async function rejection(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail, but it returned a value.');
}
