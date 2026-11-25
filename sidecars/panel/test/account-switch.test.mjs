import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractNativeOAuthClients,
  resolveGoogleCredential,
  retrieveCredentialQuota,
} from '../backend/account-oauth.mjs';
import {
  handleAccountCredentialAction,
  normalizeAccountCredential,
  normalizeAccountEmail,
  runWindowsCredentialStore,
} from '../backend/account-switch.mjs';

test('accepts a shared OAuth credential or refresh token, and rejects other credential types', () => {
  const refreshToken = '1//synthetic-refresh-token-for-test';
  assert.deepEqual(JSON.parse(normalizeAccountCredential(refreshToken)), {
    auth_method: 'consumer',
    token: {
      access_token: '',
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: '1970-01-01T00:00:00.000Z',
    },
  });
  const saved = JSON.parse(
    normalizeAccountCredential(
      JSON.stringify({
        token: {
          refresh_token: refreshToken,
          access_token: 'example-access',
          expiry_timestamp: 1800000000,
        },
      })
    )
  );
  assert.equal(saved.token.access_token, 'example-access');
  assert.equal(saved.token.expiry, '2027-01-15T08:00:00.000Z');
  assert.equal(
    normalizeAccountCredential(
      JSON.stringify({ auth_method: 'enterprise', refresh_token: refreshToken })
    ),
    null
  );
  assert.equal(normalizeAccountCredential('example-api-key'), null);
  assert.equal(normalizeAccountEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeAccountEmail('not-an-email'), '');
});

test('binary OAuth client extraction and Google OAuth/quota queries are hard-disabled', async () => {
  const fakePe = Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(128),
    Buffer.from('123456-fakeclient.apps.googleusercontent.com\0GOCSPX-fake-secret-value\0'),
  ]);
  assert.deepEqual(extractNativeOAuthClients(fakePe), []);
  assert.deepEqual(extractNativeOAuthClients(Buffer.alloc(0)), []);

  let fetchCalled = false;
  let clientsCalled = false;
  await assert.rejects(
    () =>
      resolveGoogleCredential(
        { token: { refresh_token: '1//synthetic-refresh-token-for-test' } },
        {
          fetchFn: async () => {
            fetchCalled = true;
            return { ok: true, json: async () => ({}) };
          },
          getClients: async () => {
            clientsCalled = true;
            return [{ id: 'x', secret: 'y' }];
          },
        }
      ),
    { message: 'disabled_in_hardened_fork' }
  );
  assert.equal(fetchCalled, false);
  assert.equal(clientsCalled, false);

  await assert.rejects(
    () =>
      retrieveCredentialQuota('fake-access-token', async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({}) };
      }),
    { message: 'disabled_in_hardened_fork' }
  );
  assert.equal(fetchCalled, false);
});

test('Windows credential store and account switching actions are hard-disabled on all platforms', async () => {
  await assert.rejects(
    () => runWindowsCredentialStore({ action: 'list' }),
    { message: 'disabled_in_hardened_fork' }
  );

  const expectedDisabled = {
    supported: false,
    disabled: true,
    accounts: [],
    selectedEmail: '',
    error: 'disabled_in_hardened_fork',
  };

  let sideEffectsCalled = false;
  const mockDeps = {
    store: async () => {
      sideEffectsCalled = true;
      return {};
    },
    rpc: async () => {
      sideEffectsCalled = true;
      return {};
    },
    resolveCredential: async () => {
      sideEffectsCalled = true;
      return {};
    },
    getQuota: async () => {
      sideEffectsCalled = true;
      return [];
    },
  };

  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const action of ['list', 'save', 'capture', 'switch', 'remove', 'quota']) {
      const res = await handleAccountCredentialAction(
        {
          action,
          email: 'user@example.com',
          credential: '1//synthetic-refresh-token-for-test',
        },
        { ...mockDeps, platform }
      );
      assert.deepEqual(res, expectedDisabled);
    }
  }
  assert.equal(sideEffectsCalled, false);
});
