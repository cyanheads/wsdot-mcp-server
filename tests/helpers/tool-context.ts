/**
 * @fileoverview Mock contexts typed against a definition's error contract.
 * `createMockContext` returns the base `Context`, but a definition that declares `errors[]`
 * receives a `HandlerContext` carrying the contract-bound `fail` and `recoveryFor`. Handler
 * calls in tests therefore need the contract-aware shape, which this module builds from the
 * definition itself — no cast, and no drift from the contract each tool actually declares.
 * @module tests/helpers/tool-context
 */

import {
  type Context,
  createFail,
  type ReasonOf,
  type TypedFail,
  type TypedRecoveryFor,
} from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextOptions } from '@cyanheads/mcp-ts-core/testing';

/** The slice of a definition this module reads — every tool in this server declares a contract. */
interface WithErrorContract {
  readonly errors?: readonly ErrorContract[] | undefined;
}

/** A mock context carrying the `fail`/`recoveryFor` pair a contract-declaring handler expects. */
export type ContractContext<R extends string> = Context & {
  fail: TypedFail<R>;
  recoveryFor: TypedRecoveryFor<R>;
};

/**
 * Resolves a declared reason to its contract recovery hint. `TypedRecoveryFor` constrains the
 * reason to the declared union, so an unresolved reason means the contract and the caller have
 * diverged — that throws rather than resolving to a placeholder hint.
 */
function recoveryResolver<R extends string>(errors: readonly ErrorContract[]): TypedRecoveryFor<R> {
  return (reason) => {
    const entry = errors.find((e) => e.reason === reason);
    if (!entry) throw new Error(`No error contract entry declares the reason "${reason}".`);
    return { recovery: { hint: entry.recovery } };
  };
}

/**
 * Builds a mock context for `definition.handler`, wiring `fail` and `recoveryFor` from the
 * definition's own `errors[]` the way the production handler factory does.
 *
 * @param definition - Tool or resource definition whose handler will receive the context.
 * @param options - Forwarded to `createMockContext` (tenantId, elicit, progress, …).
 */
export function toolContext<D extends WithErrorContract>(
  definition: D,
  options: MockContextOptions = {},
): ContractContext<ReasonOf<D['errors']>> {
  const errors = definition.errors ?? [];
  return Object.assign(createMockContext(options), {
    fail: createFail(errors),
    recoveryFor: recoveryResolver<ReasonOf<D['errors']>>(errors),
  });
}
