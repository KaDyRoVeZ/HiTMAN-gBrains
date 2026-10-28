/**
 * The one AI-gateway bootstrap for eval runners that bring their own brain
 * (in-memory PGLite) instead of going through `connectEngine`.
 *
 * Reads `~/.gbrain/config.json` when present, else the environment
 * (`GBRAIN_EMBEDDING_MODEL` / `GBRAIN_EMBEDDING_DIMENSIONS`), and folds provider
 * keys from both planes through `buildGatewayConfig`, so an eval sees the same
 * models, keys and base URLs the user's brain uses. `chatModel` is the runner's
 * default for brains with no configured `chat_model`; a configured one wins.
 */
import { buildGatewayConfig } from '../../core/ai/build-gateway-config.ts';
import { configureGateway } from '../../core/ai/gateway.ts';
import { loadConfig, type GBrainConfig } from '../../core/config.ts';

export function configureEvalGateway(opts: { chatModel?: string } = {}): void {
  const config = loadConfig() ?? ({
    embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
    embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS
      ? Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) : undefined,
  } as GBrainConfig);
  const gateway = buildGatewayConfig(config);
  if (!gateway.chat_model && opts.chatModel) gateway.chat_model = opts.chatModel;
  configureGateway(gateway);
}
