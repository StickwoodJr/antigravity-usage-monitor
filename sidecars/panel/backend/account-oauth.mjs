/** @fileoverview Hard-disabled Google OAuth identity and quota queries in this hardened fork. */

export function extractNativeOAuthClients() {
  return [];
}

export async function resolveGoogleCredential() {
  throw new Error('disabled_in_hardened_fork');
}

export async function retrieveCredentialQuota() {
  throw new Error('disabled_in_hardened_fork');
}
