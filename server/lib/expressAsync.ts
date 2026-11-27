import { createRequire } from 'node:module';

/**
 * Routes rejected promises from async handlers to Express's error middleware.
 *
 * Express 4 wraps a handler in `try { fn(req, res, next) } catch`, which only
 * catches a *synchronous* throw. A handler declared `async` returns a promise,
 * so anything it rejects with — including a failure raised after a write has
 * already committed — is never seen by the framework. Nothing answers the
 * request, the socket eventually times out, and the browser reports a network
 * error for a mutation that actually happened.
 *
 * Patching the layer once is what `express-async-errors` does; doing it here
 * keeps it in-repo, applies to every route (including future ones) instead of
 * only the handlers someone remembered to wrap, and costs one branch per request.
 */

let installed = false;

export function installAsyncErrorForwarding(): void {
  if (installed) return;
  const require = createRequire(import.meta.url);
  const Layer = require('express/lib/router/layer');

  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(this: unknown, req: any, res: any, next: any) {
    const fn = (this as any).handle;
    // Four-argument handlers are error middleware; Express skips those itself.
    if (typeof fn !== 'function' || fn.length > 3) return original.call(this, req, res, next);
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(undefined, next);
      }
      return result;
    } catch (err) {
      next(err);
      return undefined;
    }
  };
  installed = true;
}
