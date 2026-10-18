/** DSH 0.2.1-rc.2 integration; MiniMax Code owns credential persistence. */
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';

/** Resolve adapter defaults from the installed host rather than duplicating its limits. */
export function profileDefaults() {
  const profile = PiAiConfig({ providers: { minimax: {} } }).providers.get().minimax;
  return {
    maxRequestImageBytes: profile.maxRequestImageBytes,
    requestImagePixelBudget: profile.requestImagePixelBudget,
    requestImageMaxBytes: profile.requestImageMaxBytes,
    retryPolicy: resolveRetryPolicy(profile.retryPolicy, 'minimax-connect retryPolicy'),
  };
}

/** Inject explicit auth ownership and the host's current attachment/path services. */
export function hostOptions(ctx) {
  const rejectCredentialWrite = async () => {
    throw new Error('MiniMax Code owns this login; authenticate through MiniMax Code.');
  };
  return {
    auth: {
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: rejectCredentialWrite,
        delete: rejectCredentialWrite,
      },
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  };
}
