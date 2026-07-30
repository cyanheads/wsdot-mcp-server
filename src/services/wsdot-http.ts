/**
 * @fileoverview Shared upstream-HTTP handling for the WSDOT Traffic and WSF Ferry services.
 * Owns the three things both services must get identically right: keeping the access code out
 * of every error payload, classifying network/timeout failures, and turning a non-2xx (or an
 * HTML/auth-shaped) response into the `invalid_access_code` / `api_unavailable` contract the
 * tools declare.
 * @module services/wsdot-http
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { configurationError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';

/** Env var holding the credential both APIs authenticate with. Named in every access-code error. */
const ACCESS_CODE_ENV = 'WSDOT_ACCESS_CODE';

/** Where an operator registers for a code. */
const REGISTRATION_URL = 'https://wsdot.wa.gov/traffic/api/';

/** Maximum characters of an upstream error body carried into `error.data.body`. */
const BODY_LIMIT = 300;

/** Body that opens as an HTML document. */
const HTML_DOCUMENT = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/** WSF names the credential in its rejection body ("…for a developer Access Code…"). */
const NAMES_ACCESS_CODE = /access\s*code/i;

/**
 * `AccessCode=` / `apiaccesscode=` and their value, anywhere in a text blob. Upstream error
 * pages echo the request query string, so any text copied into an error must be scrubbed.
 * The parameter name goes with the value — otherwise an echoed query string reads as the
 * upstream naming the credential as the fault.
 */
const CREDENTIAL_ASSIGNMENT = /\S*access_?code=[^&\s"'<]*/gi;

/** Stand-in left where a credential assignment was removed. */
const REDACTED = '[credential redacted]';

/** Options for {@link assertUpstreamJson}. */
export interface UpstreamCheck {
  /** Response body, already read as text. */
  body: string;
  /** Request URL with the credential-bearing query string removed. */
  endpoint: string;
  /** The upstream response whose body was read into `body`. */
  response: Response;
  /** Display name of the upstream API, used in error messages. */
  service: string;
}

/**
 * Drop the query string — it carries `AccessCode` / `apiaccesscode`. Error payloads, messages,
 * and log fields use this form so the credential never leaves the process.
 */
export function redactUrl(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** Replace any credential assignment inside free text with a placeholder. */
function scrub(text: string): string {
  return text.replace(CREDENTIAL_ASSIGNMENT, REDACTED);
}

/** Cap a scrubbed string. Scrubbing runs first so a truncation can never leave a partial
 * credential behind. */
function cap(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text;
}

/**
 * Both APIs authenticate solely with the access code, so a 4xx whose body names the access code —
 * how WSF answers an unregistered one — is a credential problem rather than a bad request, as is
 * any 401/403.
 *
 * @param body - The *scrubbed* body: an echoed request query string must not read as the upstream
 *   naming the credential as the fault.
 */
function rejectsAccessCode(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  return status >= 400 && status < 500 && NAMES_ACCESS_CODE.test(body);
}

/**
 * Fetch `url`, cancelling on `ctx.signal` or after `timeoutMs`.
 *
 * Network rejections are re-thrown as classified `McpError`s carrying only `endpoint`: Bun and
 * Node attach the requested URL — access code and all — to network errors as `error.path`, so the
 * raw rejection is never re-thrown, chained as `cause`, or logged. Only its message survives,
 * scrubbed.
 *
 * @param url - Full request URL including the access code.
 * @param endpoint - The same URL with its query string removed ({@link redactUrl}).
 */
export async function fetchUpstream(
  url: string,
  endpoint: string,
  service: string,
  timeoutMs: number,
  ctx: Context,
): Promise<Response> {
  const signal = ctx.signal.aborted
    ? ctx.signal
    : AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    return await fetch(url, { signal });
  } catch (cause) {
    if (ctx.signal.aborted) {
      throw timeout(`${service} request cancelled.`, { url: endpoint });
    }
    const name = cause instanceof Error ? cause.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw timeout(`${service} request timed out after ${timeoutMs}ms.`, {
        url: endpoint,
        timeoutMs,
      });
    }
    const detail = scrub(cause instanceof Error ? cause.message : String(cause));
    throw serviceUnavailable(`${service} request failed: ${detail}`, {
      url: endpoint,
      reason: 'api_unavailable',
      ...ctx.recoveryFor('api_unavailable'),
    });
  }
}

/**
 * Throw unless the response is a JSON success.
 *
 * The body is inspected *before* any status check, because both APIs explain an unregistered
 * access code in the body of a 400: WSDOT Traffic answers `Content-Type: text/html` with
 * `Bad Request`, WSF answers JSON naming the access code. Those become `invalid_access_code`
 * (a server configuration fault, non-retryable); every other non-2xx becomes `api_unavailable`.
 */
export function assertUpstreamJson(
  { body, endpoint, response, service }: UpstreamCheck,
  ctx: Context,
): void {
  const contentType = response.headers.get('content-type') ?? '';
  const htmlPage = contentType.includes('text/html');
  const htmlBody = HTML_DOCUMENT.test(body);
  // Success bodies are the hot path and can be large — nothing below touches them.
  if (response.ok && !htmlPage && !htmlBody) return;

  const scrubbed = scrub(body).trim();
  const snippet = cap(scrubbed);
  const upstream = htmlBody || snippet === '' ? '' : ` Upstream: "${snippet}".`;

  // HTML is how both APIs answer an unregistered access code — WSDOT Traffic pairs it with a 400,
  // and a 2xx login page carries the same meaning. A 5xx HTML page is an outage page: reporting it
  // as a credential fault would blame the operator's config and skip the retry it deserves.
  const htmlAuthPage = response.status < 500 && (htmlPage || htmlBody);

  if (htmlAuthPage || rejectsAccessCode(response.status, scrubbed)) {
    const detail = htmlPage
      ? 'returned an HTML page instead of JSON'
      : htmlBody
        ? 'returned HTML content instead of JSON'
        : `rejected the request with HTTP ${response.status}`;
    throw configurationError(
      `${service} ${detail} — ${ACCESS_CODE_ENV} is missing, invalid, or not registered.${upstream} Register an access code at ${REGISTRATION_URL} and set ${ACCESS_CODE_ENV}.`,
      {
        url: endpoint,
        status: response.status,
        body: snippet,
        reason: 'invalid_access_code',
        ...ctx.recoveryFor('invalid_access_code'),
      },
    );
  }

  if (!response.ok) {
    throw serviceUnavailable(`${service} returned HTTP ${response.status}.${upstream}`, {
      url: endpoint,
      status: response.status,
      body: snippet,
      reason: 'api_unavailable',
      ...ctx.recoveryFor('api_unavailable'),
      // 4xx is a client error that won't succeed on retry — mark non-retryable so withRetry
      // fails fast instead of burning all attempts (the data.retryable === false opt-out).
      ...(response.status >= 400 && response.status < 500 && { retryable: false }),
    });
  }
}
