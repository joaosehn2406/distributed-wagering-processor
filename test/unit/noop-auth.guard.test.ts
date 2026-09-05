import { expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { NoopAuthGuard } from '../../src/bootstrap/noop-auth.guard.js';

test('keeps the explicit future OIDC guard seam open without local authentication', () => {
  expect(new NoopAuthGuard().canActivate({} as ExecutionContext)).toBe(true);
});
