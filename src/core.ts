/**
 * Vigilante externo de NOVA — lógica pura (sin red ni reloj), para poder probarla.
 *
 * WHY existe: si NOVA o el gateway se caen, no pueden avisar de que se cayeron. Este vigilante corre
 * FUERA de Render (GitHub Actions) y le escribe al fundador por WhatsApp directo a la API de Meta.
 * `run.ts` hace la parte con red; aquí solo se decide qué medir como "sano", cuándo avisar y qué decir.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WatchState {
  status: 'ok' | 'down';
  /** Epoch ms del inicio de la caída actual. */
  since: number | null;
  lastAlertAt: number | null;
  failing: string[];
}

export interface Alert {
  kind: 'down' | 'still_down' | 'recovered';
  failing: string[];
  since: number | null;
}

export const INITIAL_STATE: WatchState = { status: 'ok', since: null, lastAlertAt: null, failing: [] };

/** Mientras siga caído por lo mismo, se recuerda una vez por hora (no cada 5 minutos). */
export const REPEAT_MS = 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function judgeChannelsReadyz(status: number, body: unknown): CheckResult {
  const name = 'channels-api';
  if (status !== 200) return { name, ok: false, detail: `HTTP ${status}` };
  if (!isObj(body)) return { name, ok: false, detail: 'respuesta ilegible' };
  if (body.ok !== true) return { name, ok: false, detail: 'ok:false' };
  const creds = body.credentials;
  if (isObj(creds) && creds.webhook_ready === false) return { name, ok: false, detail: 'webhook no listo' };
  return { name, ok: true, detail: 'ok' };
}

/** `llm` cuenta (sin modelo NOVA no puede pensar); `stt` no (la voz es opcional). */
export function judgeNovaReadyz(status: number, body: unknown): CheckResult {
  const name = 'nova-web';
  if (status !== 200) return { name, ok: false, detail: `HTTP ${status}` };
  if (!isObj(body)) return { name, ok: false, detail: 'respuesta ilegible' };
  const missing = (['ready', 'llm', 'channels'] as const).filter((k) => body[k] !== true);
  if (missing.length) return { name, ok: false, detail: `falla: ${missing.join(', ')}` };
  return { name, ok: true, detail: 'ok' };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function decide(
  prev: WatchState,
  failingNow: string[],
  now: number,
  repeatMs: number = REPEAT_MS,
): { next: WatchState; alert: Alert | null } {
  const failing = [...new Set(failingNow)].sort();

  if (failing.length === 0) {
    if (prev.status === 'down') return { next: { ...INITIAL_STATE }, alert: { kind: 'recovered', failing: [], since: prev.since } };
    return { next: { ...INITIAL_STATE }, alert: null };
  }

  if (prev.status === 'ok') {
    return {
      next: { status: 'down', since: now, lastAlertAt: now, failing },
      alert: { kind: 'down', failing, since: now },
    };
  }

  const since = prev.since ?? now;
  const hasNew = failing.some((f) => !prev.failing.includes(f));
  if (hasNew) {
    return { next: { status: 'down', since, lastAlertAt: now, failing }, alert: { kind: 'down', failing, since } };
  }
  const lastAlertAt = prev.lastAlertAt ?? since;
  if (now - lastAlertAt >= repeatMs) {
    return { next: { status: 'down', since, lastAlertAt: now, failing }, alert: { kind: 'still_down', failing, since } };
  }
  return { next: { status: 'down', since, lastAlertAt, failing: sameSet(failing, prev.failing) ? prev.failing : failing }, alert: null };
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export interface Composed {
  /** Texto libre: solo lo acepta WhatsApp si el fundador escribió en las últimas 24 h. */
  text: string;
  /** Plantilla aprobada: entra en cualquier momento. Variables de una sola línea, como exige Meta. */
  template: { name: string; language: string; bodyParams: string[]; buttonParam: string };
}

/** Una sola línea, sin saltos ni tabuladores ni 5+ espacios seguidos (Meta rechaza variables con eso). */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 240);

export function compose(alert: Alert, now: number): Composed {
  const who = alert.failing.join(', ');
  // Menos de un minuto no se menciona: "lleva 0 min" no informa nada.
  const dur = alert.since == null || now - alert.since < 60_000 ? '' : formatDuration(now - alert.since);
  const button = 'nova/ops/watchdog';
  const customer = 'NEXUM (vigilante externo)';

  if (alert.kind === 'recovered') {
    const situation = oneLine(`Se recuperó${dur ? ` tras ${dur}` : ''}`);
    return {
      text: `✅ NOVA · recuperado\nTodo volvió a responder${dur ? ` después de ${dur} caído` : ''}.`,
      template: {
        name: 'nova_founder_alert_p1_es_co_v1',
        language: 'es_CO',
        bodyParams: [oneLine(customer), situation, 'Nada, solo estar enterado'],
        buttonParam: button,
      },
    };
  }

  const situation = oneLine(alert.kind === 'still_down' ? `Sigue caído hace ${dur}: ${who}` : `No responde: ${who}`);
  const head = alert.kind === 'still_down' ? '🚨 NOVA · sigue caído' : '🚨 NOVA · caída detectada';
  return {
    text: `${head}\nNo responde: ${who}${alert.kind === 'still_down' && dur ? `\nLleva ${dur}` : ''}\nLos clientes pueden estar sin respuesta por WhatsApp.\nEl vigilante solo avisa, no repara: revisa Render.`,
    template: {
      name: 'nova_founder_alert_p0_es_co_v1',
      language: 'es_CO',
      bodyParams: [
        oneLine(customer),
        situation,
        'Los clientes pueden quedar sin respuesta por WhatsApp',
        'Solo avisar: el vigilante no repara nada',
        'Revisar los servicios en Render',
      ],
      buttonParam: button,
    },
  };
}
