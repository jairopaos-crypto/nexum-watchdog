/**
 * Vigilante externo de NOVA — parte con red. Se ejecuta desde GitHub Actions cada 5 minutos
 * (`.github/workflows/watchdog.yml`), fuera de Render, para poder avisar aunque Render esté caído.
 *
 * Secretos por variable de entorno (nunca se imprimen):
 *   WATCHDOG_META_TOKEN, WATCHDOG_PHONE_NUMBER_ID, WATCHDOG_TO
 * Opcionales: WATCHDOG_STATE_FILE, WATCHDOG_RETRY_WAIT_MS, WATCHDOG_DRY_RUN=1,
 *             WATCHDOG_SIMULATE=<nombre del componente que se finge caído, p. ej. nova-web>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  compose,
  decide,
  INITIAL_STATE,
  judgeChannelsReadyz,
  judgeNovaReadyz,
  type CheckResult,
  type Composed,
  type WatchState,
} from './core.js';

const env = process.env;
const CHANNELS_URL = env.WATCHDOG_CHANNELS_URL ?? 'https://nexum-channels-api.onrender.com';
const NOVA_URL = env.WATCHDOG_NOVA_URL ?? 'https://nexum-nova-web.onrender.com';
const STATE_FILE = env.WATCHDOG_STATE_FILE ?? '.watchdog-state.json';
const RETRY_WAIT_MS = Number(env.WATCHDOG_RETRY_WAIT_MS ?? 45_000);
const GRAPH = 'https://graph.facebook.com/v21.0';
const DRY = env.WATCHDOG_DRY_RUN === '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(url: string, judge: (s: number, b: unknown) => CheckResult, name: string): Promise<CheckResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* cuerpo no JSON: el criterio lo trata como ilegible */
    }
    return judge(res.status, body);
  } catch (e) {
    return { name, ok: false, detail: `sin respuesta (${(e as Error).name})` };
  }
}

async function round(): Promise<CheckResult[]> {
  return Promise.all([
    probe(`${CHANNELS_URL}/readyz`, judgeChannelsReadyz, 'channels-api'),
    probe(`${NOVA_URL}/readyz`, judgeNovaReadyz, 'nova-web'),
  ]);
}

function loadState(): WatchState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<WatchState>;
    if ((s.status === 'ok' || s.status === 'down') && Array.isArray(s.failing)) {
      return { status: s.status, since: s.since ?? null, lastAlertAt: s.lastAlertAt ?? null, failing: s.failing };
    }
  } catch {
    /* primera ejecución o caché vacía */
  }
  return { ...INITIAL_STATE };
}

async function graphSend(payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const { WATCHDOG_META_TOKEN: token, WATCHDOG_PHONE_NUMBER_ID: pn } = env;
  if (!token || !pn) return { ok: false, detail: 'faltan WATCHDOG_META_TOKEN / WATCHDOG_PHONE_NUMBER_ID' };
  try {
    const res = await fetch(`${GRAPH}/${pn}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: env.WATCHDOG_TO, ...payload }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
    if (res.ok) return { ok: true, detail: 'enviado' };
    return { ok: false, detail: `HTTP ${res.status} código ${body.error?.code ?? '?'}: ${String(body.error?.message ?? '').slice(0, 160)}` };
  } catch (e) {
    return { ok: false, detail: `sin respuesta (${(e as Error).name})` };
  }
}

const sendTemplate = (c: Composed) =>
  graphSend({
    type: 'template',
    template: {
      name: c.template.name,
      language: { code: c.template.language },
      components: [
        { type: 'body', parameters: c.template.bodyParams.map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: c.template.buttonParam }] },
      ],
    },
  });
const sendText = (c: Composed) => graphSend({ type: 'text', text: { body: c.text } });

async function deliver(kind: string, c: Composed): Promise<boolean> {
  if (DRY) {
    console.log(`[dry-run] ${kind}: se enviaría la plantilla ${c.template.name} o, si no, este texto:\n${c.text}`);
    return true;
  }
  // Una caída va primero por plantilla (llega siempre); la recuperación va primero por texto (gratis dentro de la ventana).
  const order: Array<['plantilla' | 'texto', (c: Composed) => Promise<{ ok: boolean; detail: string }>]> =
    kind === 'recovered' ? [['texto', sendText], ['plantilla', sendTemplate]] : [['plantilla', sendTemplate], ['texto', sendText]];
  for (const [label, fn] of order) {
    const r = await fn(c);
    console.log(`envío por ${label}: ${r.ok ? 'OK' : 'falló'} (${r.detail})`);
    if (r.ok) return true;
  }
  return false;
}

async function main(): Promise<number> {
  const simulate = env.WATCHDOG_SIMULATE?.trim();
  let failing: string[];

  if (simulate) {
    console.log(`SIMULACIÓN: se finge caído → ${simulate}`);
    failing = [simulate];
  } else {
    const first = await round();
    first.forEach((r) => console.log(`${r.name}: ${r.ok ? 'sano' : 'FALLA'} (${r.detail})`));
    const bad1 = first.filter((r) => !r.ok).map((r) => r.name);
    if (bad1.length === 0) {
      failing = [];
    } else {
      console.log(`Confirmando en ${Math.round(RETRY_WAIT_MS / 1000)} s…`);
      await sleep(RETRY_WAIT_MS);
      const second = await round();
      second.forEach((r) => console.log(`(2ª ronda) ${r.name}: ${r.ok ? 'sano' : 'FALLA'} (${r.detail})`));
      const bad2 = new Set(second.filter((r) => !r.ok).map((r) => r.name));
      failing = bad1.filter((n) => bad2.has(n));
    }
  }

  const now = Date.now();
  const prev = loadState();
  const { next, alert } = decide(prev, failing, now);

  if (!alert) {
    console.log(`Sin aviso (estado: ${next.status}${next.failing.length ? ` · ${next.failing.join(', ')}` : ''}).`);
    writeFileSync(STATE_FILE, JSON.stringify(next));
    return 0;
  }

  console.log(`Aviso: ${alert.kind} · ${alert.failing.join(', ') || '—'}`);
  const delivered = await deliver(alert.kind, compose(alert, now));
  if (!delivered) {
    // No se guarda el estado nuevo: la próxima ejecución lo reintenta. El rojo del workflow avisa por correo de GitHub.
    console.error('NO SE PUDO AVISAR POR WHATSAPP. Se reintentará en la próxima ejecución.');
    return 1;
  }
  writeFileSync(STATE_FILE, JSON.stringify(next));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('Error inesperado del vigilante:', (e as Error).message);
    process.exit(1);
  },
);
