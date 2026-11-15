import type { Request, Response } from 'express';

export type Audience = 'staff' | 'kiosk';
interface Client { res: Response; audience: Audience }

/** Server-Sent Events hub. Staff and kiosk clients get separate event sets. */
export class EventHub {
  private clients = new Set<Client>();
  private nextId = 1;

  constructor() {
    // Keep idle proxies/sockets open and detect dead clients.
    setInterval(() => this.clients.forEach((c) => c.res.write(': ping\n\n')), 25_000).unref();
  }

  attach(req: Request, res: Response, audience: Audience, initial?: () => Array<[string, unknown]>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const client = { res, audience };
    this.clients.add(client);
    // A reconnecting client gets the current state at once.
    for (const [event, data] of initial?.() ?? []) this.write(client, event, data);
    req.on('close', () => this.clients.delete(client));
  }

  send(event: string, data: unknown, audiences: Audience[] = ['staff']): void {
    for (const c of this.clients) if (audiences.includes(c.audience)) this.write(c, event, data);
  }

  private write(c: Client, event: string, data: unknown) {
    c.res.write(`id: ${this.nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
