import { z } from 'zod';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';
import { getGeoModelConnection, loadGeoModel, type GeoStructuredModel } from './connection-settings';
import { readAgentParameters } from './agent-files';

export function improvementModelSettings(
  subscription: Pick<ReturnType<typeof getChatGPTStatus>, 'enabled' | 'connected' | 'planEnabled' | 'model'> = getChatGPTStatus(),
  api: Pick<ReturnType<typeof getGeoModelConnection>, 'configured' | 'model'> = getGeoModelConnection(),
) {
  if (subscription.enabled) return {
    modelConfigured: Boolean(subscription.connected && subscription.planEnabled && subscription.model),
    modelName: subscription.model || null, provider: 'subscription' as const,
  };
  return { modelConfigured: api.configured, modelName: api.configured ? api.model : null, provider: 'api' as const };
}

/** Honor the selected analysis connection. A subscription failure never falls back to a paid API. */
export async function loadImprovementModel(dependencies = {
  settings: improvementModelSettings,
  subscription: (timeoutMs: number): GeoStructuredModel => new ChatGPTModel({ timeoutMs }),
  api: loadGeoModel,
}): Promise<GeoStructuredModel> {
  const settings = dependencies.settings();
  if (!settings.modelConfigured) throw new Error('请先在设置中连接分析模型。');
  if (settings.provider === 'subscription') {
    const { subscriptionTimeoutMs } = readAgentParameters('improvement-planning', z.object({ subscriptionTimeoutMs: z.number().int().positive() }));
    return dependencies.subscription(subscriptionTimeoutMs);
  }
  return dependencies.api();
}
