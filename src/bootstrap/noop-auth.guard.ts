import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
/** Explicit integration seam: replace with an OIDC ProviderIdentityPort adapter. */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    void _context;
    return true;
  }
}
