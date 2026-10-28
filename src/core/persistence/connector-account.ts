/**
 * Resolve the account a connector credential actually belongs to, before any
 * service runs (#5686 account pin). Credential-delivery fields are excluded
 * from the connector identity, so a swapped token behind an unchanged
 * `g_token_env` / `gh_token_env` name is caught here instead.
 */
import type { GoogleService } from '../google/types.ts';
import { probeGoogleAccount, type GoogleAccountProbe, type GoogleIdentityClients } from '../google/api-access.ts';
import type { GitHubClient, GitHubSourceConfig } from '../github-source.ts';
import type { ConnectorAccount } from './connector-state.ts';
import { CredentialError } from '../creds/errors.ts';

/**
 * Google: the first enabled service whose granted scope can name the account
 * (Gmail profile, Calendar primary calendar, People `me`), else the OAuth
 * userinfo endpoint (#7073), with every per-service failure kept in the
 * result. When nothing names the account, the failure is rethrown instead of
 * reported as an account change (#7004): api_not_enabled first, then any
 * other credential error, then the first other failure (a network error stays
 * a transient failure, never an account refusal). `email` is null only when
 * every attempt answered without an address.
 */
export async function resolveGoogleAccount(clients: GoogleIdentityClients, services: readonly GoogleService[], signal?: AbortSignal): Promise<GoogleAccountProbe> {
  const probe = await probeGoogleAccount(clients, services, signal ? { signal } : {});
  if (probe.email) return probe;
  const failures = Object.values(probe.errors);
  const refusal = failures.find(error => error instanceof CredentialError && error.code === 'api_not_enabled')
    ?? failures.find(error => error instanceof CredentialError) ?? failures[0];
  if (refusal !== undefined) throw refusal;
  return probe;
}

/**
 * GitHub: an App resolves to the installation its token was minted for; token
 * auth under `scope: auto` resolves to the authenticated login. Token auth
 * under `scope: repos` reads an explicit repo list, so it pins nothing.
 */
export async function resolveGitHubAccount(cfg: GitHubSourceConfig, client: GitHubClient,
  app: { getToken(): Promise<string>; installationId: number | null } | null, signal?: AbortSignal): Promise<ConnectorAccount> {
  if (app) {
    await app.getToken();
    return { kind: 'github', installationId: app.installationId, login: null };
  }
  if (cfg.scope !== 'auto') return { kind: 'github', installationId: null, login: null };
  const user = await client.fetchJSON<{ login?: string }>('/user', signal ? { signal } : {});
  return { kind: 'github', installationId: null, login: typeof user.login === 'string' ? user.login : null };
}
