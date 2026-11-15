import { createRequire } from 'node:module';
import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { getSetting, schema, writeSynced, type Db } from '@pmp/db';
import { PRINT_ROUTES, PRINT_TILES, type PrinterKey, type PrintSize } from '@pmp/shared';
import type { EventHub } from '../events';
import { sessionDir } from '../photos/ingest';
import { buildPrintPdf, parseInches } from './layout';

export interface PrintOptions { printer: string; paperSize?: string; orientation: 'portrait' | 'landscape'; copies: number }
/** The OS-facing part, swapped out in tests. */
export interface Spooler {
  listPrinters(): Promise<string[]>;
  print(pdf: string, o: PrintOptions): Promise<void>;
}

/** Windows spooler via pdf-to-printer's bundled SumatraPDF: no dialogs, no Acrobat needed. */
export function windowsSpooler(): Spooler {
  const req = createRequire(import.meta.url);
  const ptp = req('pdf-to-printer') as typeof import('pdf-to-printer');
  // Executables cannot run from inside app.asar; electron-builder unpacks this folder.
  const sumatraPdfPath = path.join(path.dirname(req.resolve('pdf-to-printer')), 'SumatraPDF-3.4.6-32.exe')
    .replace('app.asar', 'app.asar.unpacked');
  return {
    listPrinters: async () => (await ptp.getPrinters()).map((p) => p.name),
    print: (pdf, o) => ptp.print(pdf, {
      printer: o.printer, paperSize: o.paperSize, orientation: o.orientation, copies: o.copies,
      scale: 'noscale', silent: true, sumatraPdfPath,
    }),
  };
}

const DEFAULT_PRINTER_MATCH: Record<PrinterKey, string> = { dnp: 'DS620', pixma: 'PIXMA' };

/**
 * Settings (all optional), so a site can fix routing without a release:
 *   print.printer.dnp / print.printer.pixma  – name or part of the Windows printer name
 *   print.printer.<size>                      – per-size override, e.g. a second "DS620 5x7" queue
 *   print.paper.<size>                        – driver paper name, e.g. "(5x7)"
 */
export function resolvePrinter(db: Db, size: PrintSize, installed: string[]): { printer: string; paperSize?: string } {
  const key = PRINT_ROUTES[size];
  const media = size === 'wallet4' ? '5x7' : size; // wallet sheets use the 5x7 media/queue
  const want = getSetting(db, `print.printer.${media}`) ?? getSetting(db, `print.printer.${key}`) ?? DEFAULT_PRINTER_MATCH[key];
  const lower = want.toLowerCase();
  const printer = installed.find((n) => n.toLowerCase() === lower)
    ?? installed.filter((n) => n.toLowerCase().includes(lower)).sort((a, b) => a.length - b.length)[0];
  if (!printer) throw new Error(`printer_not_found:${want}`);
  return { printer, paperSize: getSetting(db, `print.paper.${media}`) };
}

const MAX_ATTEMPTS = 3;
type Job = typeof schema.printJobs.$inferSelect;

/** Persistent print queue: one serial worker per physical printer so a jam on the DNP never blocks the PIXMA. */
export class PrintQueue {
  private busy = new Set<string>();

  constructor(private o: { db: Db; hub: EventHub; sessionsDir: string; spoolDir: string; spooler: Spooler }) {
    mkdirSync(o.spoolDir, { recursive: true });
  }

  /** At boot: a job caught mid-print may already be on paper, so it is never re-sent automatically. */
  recover(): void {
    for (const j of this.o.db.select().from(schema.printJobs).where(eq(schema.printJobs.status, 'printing')).all()) {
      this.update(j.id, { status: 'failed', lastError: 'interrupted_check_printer' });
    }
    this.kick();
  }

  kick(): void {
    const queued = this.o.db.select().from(schema.printJobs)
      .where(eq(schema.printJobs.status, 'queued')).orderBy(schema.printJobs.createdAt).all();
    for (const lane of new Set(queued.map((j) => PRINT_ROUTES[j.printSize]))) void this.drain(lane);
  }

  private async drain(lane: PrinterKey): Promise<void> {
    if (this.busy.has(lane)) return;
    this.busy.add(lane);
    try {
      for (;;) {
        const job = this.o.db.select().from(schema.printJobs)
          .where(eq(schema.printJobs.status, 'queued')).orderBy(schema.printJobs.createdAt).all()
          .find((j) => PRINT_ROUTES[j.printSize] === lane);
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.busy.delete(lane);
    }
  }

  private async run(job: Job): Promise<void> {
    const { db, spooler } = this.o;
    const photo = db.select().from(schema.photos).where(eq(schema.photos.id, job.photoId)).get();
    const pdf = path.join(this.o.spoolDir, `${job.id}.pdf`);
    try {
      if (!photo) throw new Error('photo_missing');
      const { printer, paperSize } = resolvePrinter(db, job.printSize, await spooler.listPrinters());
      this.update(job.id, { status: 'printing', printerName: printer, attempts: job.attempts + 1 });
      const src = path.join(sessionDir(this.o.sessionsDir, photo.sessionId), photo.fileName);
      const { landscape } = await buildPrintPdf(src, pdf, parseInches(job.printSize, job.customInches), PRINT_TILES[job.printSize]);
      await spooler.print(pdf, { printer, paperSize, orientation: landscape ? 'landscape' : 'portrait', copies: job.copies });
      this.update(job.id, { status: 'done', printedAt: Date.now(), lastError: null });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const attempts = job.attempts + 1;
      // Config errors will not fix themselves; spooler hiccups get retried.
      const final = attempts >= MAX_ATTEMPTS || /^(printer_not_found|photo_missing|custom_size)/.test(msg);
      this.update(job.id, { status: final ? 'failed' : 'queued', attempts, lastError: msg });
      if (!final) await new Promise((r) => setTimeout(r, 2000 * attempts));
    } finally {
      try { unlinkSync(pdf); } catch { /* never created */ }
    }
  }

  private update(id: string, patch: Partial<Job>) {
    const row = writeSynced(this.o.db, schema.printJobs, { id, ...patch });
    this.o.hub.send('print.updated', row);
  }
}

/** Copies already sent (or on their way) for an order line; failed/cancelled ones don't count. */
export function copiesUsed(db: Db, orderItemId: string): number {
  return db.select({ copies: schema.printJobs.copies }).from(schema.printJobs)
    .where(and(eq(schema.printJobs.orderItemId, orderItemId), inArray(schema.printJobs.status, ['queued', 'printing', 'done'])))
    .all().reduce((s, r) => s + r.copies, 0);
}
