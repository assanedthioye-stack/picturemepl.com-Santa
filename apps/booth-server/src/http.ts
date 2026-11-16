import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err); // a stream (events, a file) already started: Express closes the socket
  if (err instanceof ZodError) return res.status(400).json({ error: 'invalid', issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  // body-parser and friends: malformed JSON (400), body too large (413)…
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 413 ? 'too_large' : 'invalid_request' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal' });
}

/** CSRF hardening on top of SameSite=Strict: browsers cannot send JSON cross-site without a CORS preflight. */
export function requireJson(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/') && !req.is('application/json')) {
    res.status(415).json({ error: 'json_required' });
    return;
  }
  next();
}
