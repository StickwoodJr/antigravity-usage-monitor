/**
 * Ported & adapted from Obsidian Prism (`sidecars/daemon/redact.mjs`) by @RMvdesi (GPL-3.0-only).
 * Modified on 2026-11-26 for antigravity-usage-monitor.
 *
 * Shared secret & URL query-parameter redaction helper for logs, paths, and diagnostics.
 */

export const SECRET_TOKEN_RE =
  /(sk-[A-Za-z0-9_\-]{6,}|AIza[A-Za-z0-9_\-]{12,}|xai-[A-Za-z0-9_\-]{8,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._\-]{8,})/gi;

export const URL_SECRET_QUERY_RE = /([?&](?:token|auth|signature|key|secret)=)[^&\s#"']+/gi;

/**
 * Redact embedded URL credentials, sensitive query parameters, and API keys/bearer tokens.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeSecretText(text) {
  return String(text || '')
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***@')
    .replace(URL_SECRET_QUERY_RE, '$1<REDACTED>')
    .replace(SECRET_TOKEN_RE, '***REDACTED***');
}
