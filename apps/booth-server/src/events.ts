import type { Request, Response } from 'express';

export type Audience = 'staff' | 'kiosk';
interface Client { res: Response; audience: Audience }

/** Server-Sent Events hub. Staff and kiosk clients get separate event sets. */
export class EventHub {
  private clients = new Set<Client>();
  private nextId = 1;
  /** Last value of each sticky event, replayed to clients that connect (or reconnect) later. */
  private stickies = new Map<string, { data: unknown; audiences: Audience[] }>();

  constructor() {
    // Keep idle proxies/sockets open and detect dead clients.
    setInterval(() => this.clients.forEach((c) => this.raw(c, ': ping\n\n')), 25_000).unref();
  }

  attach(req: Request, res: Response, audience: Audience, initial?: () => Array<[string, unknown]>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const client = { res, audience };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    this.raw(client, 'retry: 2000\n\n');
    // A reconnecting client gets the current state at once.
    for (const [event, data] of initial?.() ?? []) this.write(client, event, data);
    for (const [event, s] of this.stickies) if (s.audiences.includes(audience)) this.write(client, event, s.data);
  }

  send(event: string, data: unknown, audiences: Audience[] = ['staff']): void {
    for (const c of this.clients) if (audiences.includes(c.audience)) this.write(c, event, data);
  }

  /** Like send, but also remembered: a screen that reconnects gets the current value (null = cleared). */
  sticky(event: string, data: unknown, audiences: Audience[] = ['staff']): void {
    this.stickies.set(event, { data, audiences });
    this.send(event, data, audiences);
  }

  private write(c: Client, event: string, data: unknown) {
    this.raw(c, `id: ${this.nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private raw(c: Client, text: string) {
    try {
      c.res.write(text);
    } catch {
      this.clients.delete(c); // socket already gone
    }
  }
}
