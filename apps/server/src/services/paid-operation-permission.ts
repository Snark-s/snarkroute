import { appMode } from './env';
import { ModelRoutingPolicyError } from './model-routing-policy';

/** Permission belongs to this invocation, never to credentials or saved queue state. */
export function assertPaidOperationPermission(allowPaid: unknown, provider: string): void {
  if (appMode() === 'local' && allowPaid !== true) {
    throw new ModelRoutingPolicyError('PAID_PERMISSION_REQUIRED',
      `The ${provider} operation can incur charges and requires explicit permission.`, provider);
  }
}
