import { describe, expect, test } from 'bun:test';
import { CredentialError } from '../src/core/creds/errors.ts';
import { resolveGoogleAccount } from '../src/core/persistence/connector-account.ts';

const disabled = () => { throw new CredentialError('api_not_enabled'); };
const scopeMissing = () => { throw new CredentialError('scope_missing'); };
const network = () => { throw new Error('ECONNRESET'); };
const noUserinfo = async () => { throw new CredentialError('upstream', ': userinfo HTTP 401'); };

describe('#7004 resolveGoogleAccount', () => {
  test('a disabled Gmail API surfaces as api_not_enabled, never as an unresolvable account', async () => {
    const clients = { gmail: { getProfile: disabled }, calendar: { fetchJSON: disabled }, people: { fetchJSON: disabled }, userinfo: noUserinfo } as never;
    const error = await resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts']).catch(e => e);
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe('api_not_enabled');
  });

  test('api_not_enabled is preferred over an earlier credential error', async () => {
    const clients = { gmail: { getProfile: scopeMissing }, calendar: { fetchJSON: disabled }, people: { fetchJSON: scopeMissing }, userinfo: noUserinfo } as never;
    const error = await resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts']).catch(e => e);
    expect((error as CredentialError).code).toBe('api_not_enabled');
  });

  test('a later service that names the account wins over an earlier credential error', async () => {
    const clients = {
      gmail: { getProfile: disabled },
      calendar: { fetchJSON: async () => ({ id: 'Alice@Example.com' }) },
      people: { fetchJSON: disabled },
      userinfo: noUserinfo,
    } as never;
    expect((await resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts'])).email).toBe('alice@example.com');
  });

  test('#7073: a network failure everywhere is rethrown as itself, never reported as an unresolvable account', async () => {
    const clients = { gmail: { getProfile: network }, calendar: { fetchJSON: network }, people: { fetchJSON: network }, userinfo: async () => network() } as never;
    await expect(resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts'])).rejects.toThrow('ECONNRESET');
  });

  test('#7073: services and userinfo that answer without an address still leave the account unresolved', async () => {
    const clients = { gmail: { getProfile: async () => ({}) }, calendar: { fetchJSON: async () => ({}) }, people: { fetchJSON: async () => ({}) }, userinfo: async () => undefined } as never;
    expect(await resolveGoogleAccount(clients, ['gmail', 'calendar', 'contacts'])).toEqual({ email: null, via: null, errors: {} });
  });
});
