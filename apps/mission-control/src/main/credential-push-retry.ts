interface CredentialPushResult {
  total: number;
  succeeded: number;
  failed: { deploymentId: string; name: string; error: string }[];
}

interface RetryOptions {
  delays?: number[];
}

export async function pushCredentialsWithRetry(
  pushFn: () => Promise<CredentialPushResult>,
  options?: RetryOptions,
): Promise<CredentialPushResult> {
  const delays = options?.delays ?? [2000, 4000, 8000];
  let lastResult: CredentialPushResult = { total: 0, succeeded: 0, failed: [] };

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastResult = await pushFn();
      if (lastResult.failed.length === 0) return lastResult;
    } catch (err) {
      console.error(
        `[credentials] Push attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : err,
      );
      lastResult = {
        total: 0,
        succeeded: 0,
        failed: [{ deploymentId: 'unknown', name: 'unknown', error: String(err) }],
      };
    }

    if (attempt < delays.length && lastResult.failed.length > 0) {
      console.warn(
        `[credentials] Retrying push in ${delays[attempt]}ms (attempt ${attempt + 1}/${delays.length})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  return lastResult;
}
