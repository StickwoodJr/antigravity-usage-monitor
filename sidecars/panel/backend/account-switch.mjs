/** @fileoverview Pure account credential validators; credential vault and switching are hard-disabled. */

const DISABLED_ACCOUNT_ACTION_RESULT = Object.freeze({
  supported: false,
  disabled: true,
  accounts: [],
  selectedEmail: '',
  error: 'disabled_in_hardened_fork',
});

export function normalizeAccountEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function normalizeAccountCredential(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 16384) return null;
  const text = input.trim();
  let source;
  try { source = JSON.parse(text); } catch {
    if (!/^1\/{1,2}[\w.-]{20,}$/.test(text)) return null;
    source = { refresh_token: text };
  }
  const token = source?.token || source;
  if (!token || (source.auth_method && source.auth_method !== 'consumer') ||
      typeof token.refresh_token !== 'string' || !token.refresh_token.trim() ||
      /\s/.test(token.refresh_token) || (token.token_type && !/^bearer$/i.test(token.token_type))) return null;
  const timestamp = token.expiry_date ?? (Number(token.expiry_timestamp) * 1000);
  const expiry = token.expiry || (Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799999
    ? new Date(timestamp).toISOString() : '1970-01-01T00:00:00Z');
  if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) return null;
  const payload = {
    token: {
      access_token: typeof token.access_token === 'string' ? token.access_token : '',
      refresh_token: token.refresh_token,
      token_type: 'Bearer',
      expiry: new Date(expiry).toISOString(),
    },
    auth_method: 'consumer',
  };
  const idToken = source.id_token || token.id_token;
  if (typeof idToken === 'string' && idToken) payload.id_token = idToken;
  return JSON.stringify(payload);
}

export function runWindowsCredentialStore() {
  return Promise.reject(new Error('disabled_in_hardened_fork'));
}

export async function handleAccountCredentialAction() {
  return { ...DISABLED_ACCOUNT_ACTION_RESULT, accounts: [] };
}
