/**
 * The one way this Worker writes a log line.
 *
 * Worker logs (Workers Logs, `wrangler tail`, any Logpush job) are kept by
 * Cloudflare and readable by anyone with access to the dashboard, so they
 * carry no personal data: a person is named by their account id, a Mac by its
 * device id, and never by an email address, a name, a Google subject, an IP
 * address, a token or a query string. Callers are expected to write lines
 * that way already (test/logs.test.ts holds them to it); scrub() is the net
 * underneath for text we did not write ourselves, such as an error message
 * from Stripe, Google or D1 that quotes a request back.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A query string on a URL, which is where OAuth codes and tokens travel.
const QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g;
// Bearer credentials and the shapes of the keys and tokens this service
// handles: Google access and refresh tokens, Stripe and provider secrets.
const SECRET = /\b(?:Bearer\s+\S+|ya29\.[\w.-]+|1\/\/[\w.-]+|(?:sk|rk|pk)_(?:live|test)_\w+|whsec_\w+|sk-(?:ant-)?[\w-]{6,}|gsk[-_][\w-]+)/g;

export function scrub(text: string): string {
  return text.replace(EMAIL, "[email]").replace(QUERY, "$1?[query]").replace(SECRET, "[secret]");
}

export function log(line: string): void {
  console.log(scrub(line));
}

/** log() at error level, for a line somebody has to act on (a refund owed by hand). */
export function logError(line: string): void {
  console.error(scrub(line));
}
