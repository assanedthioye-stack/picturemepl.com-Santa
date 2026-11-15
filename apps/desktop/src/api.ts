import { useEffect, useRef } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** JSON fetch against the booth server; auth rides on the HttpOnly cookie. */
export async function api<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/** Subscribes to server-sent events; EventSource reconnects by itself and the server replays current state. */
export function useEvents(handlers: Record<string, (data: any) => void>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const es = new EventSource('/api/events');
    const names = Object.keys(ref.current);
    const listeners = names.map((n) => [n, (e: MessageEvent) => ref.current[n]?.(JSON.parse(e.data))] as const);
    listeners.forEach(([n, l]) => es.addEventListener(n, l));
    return () => es.close();
  }, []);
}

export interface Me { id: string; fullName: string; role: 'admin' | 'supervisor' | 'host' | 'photographer' | 'cashier'; locale: 'fr' | 'en' }
export interface PhotoDto { id: string; sessionId: string; seq: number; hidden: boolean; favorite: boolean; previewUrl: string }
export interface CameraInfo {
  id: string; armedSessionId: string | null; driver: string; connected: boolean; model: string | null;
  batteryPercent: number | null; onAcPower: boolean; canRemoteShutter: boolean; error: string | null;
}
export interface StorageInfo {
  photosFreeGb: number | null; photosLow: boolean;
  mirror: { enabled: boolean; connected: boolean; pending: number; freeGb: number | null; low: boolean; lastError: string | null };
}
export interface SessionRow {
  id: string; code: string; status: 'dispatched' | 'armed' | 'shot_complete' | 'cancelled'; bookingCode: string; partySize: number;
}
