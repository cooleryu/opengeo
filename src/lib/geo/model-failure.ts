import { z } from 'zod';

/**
 * A short, safe reason for a failed model call: the kind of failure and, at most,
 * a field name or HTTP status. Never the provider message, request or response body.
 */
export function modelFailureReason(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return `reply did not match the expected shape: ${issue?.path.join('.') || 'root'} ${issue?.code ?? ''}`.trim();
  }
  if (!(error instanceof Error)) return 'unknown error';
  if (/^Model JSON was cut off/.test(error.message)) return 'reply was cut off at the output token limit';
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number') return `provider returned HTTP ${status}`;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timed out';
  return error.name || 'Error';
}

export function withFailureReason(message: string, error: unknown): string {
  return `${message} (${modelFailureReason(error)})`;
}
