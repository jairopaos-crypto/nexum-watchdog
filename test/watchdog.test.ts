import { describe, expect, it } from 'vitest';
import {
  compose,
  decide,
  INITIAL_STATE,
  judgeChannelsReadyz,
  judgeNovaReadyz,
  type WatchState,
} from '../src/core.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

describe('watchdog · criterio de salud', () => {
  it('channels-api sano: ok:true y webhook listo', () => {
    expect(judgeChannelsReadyz(200, { ok: true, credentials: { webhook_ready: true } }).ok).toBe(true);
  });
  it('channels-api: HTTP 503, ok:false, webhook no listo o cuerpo ilegible = caído', () => {
    expect(judgeChannelsReadyz(503, { ok: false }).ok).toBe(false);
    expect(judgeChannelsReadyz(200, { ok: false }).ok).toBe(false);
    expect(judgeChannelsReadyz(200, { ok: true, credentials: { webhook_ready: false } }).ok).toBe(false);
    expect(judgeChannelsReadyz(200, 'Bad gateway').ok).toBe(false);
    expect(judgeChannelsReadyz(0, null).ok).toBe(false);
  });
  it('nova-web sano: ready, canal y modelo; la voz (stt) no cuenta', () => {
    expect(judgeNovaReadyz(200, { ready: true, llm: true, stt: false, channels: true }).ok).toBe(true);
  });
  it('nova-web: sin modelo, sin canal o no ready = caído, y dice por qué', () => {
    const noLlm = judgeNovaReadyz(200, { ready: true, llm: false, channels: true });
    expect(noLlm.ok).toBe(false);
    expect(noLlm.detail).toMatch(/llm/);
    expect(judgeNovaReadyz(200, { ready: true, llm: true, channels: false }).ok).toBe(false);
    expect(judgeNovaReadyz(200, { ready: false, llm: true, channels: true }).ok).toBe(false);
    expect(judgeNovaReadyz(502, '<html>').ok).toBe(false);
  });
});

describe('watchdog · cuándo avisar', () => {
  it('todo sano y siempre sano: no avisa', () => {
    const r = decide(INITIAL_STATE, [], T0);
    expect(r.alert).toBeNull();
    expect(r.next.status).toBe('ok');
  });

  it('pasa de sano a caído: avisa una vez y recuerda desde cuándo', () => {
    const r = decide(INITIAL_STATE, ['nova-web'], T0);
    expect(r.alert).toEqual({ kind: 'down', failing: ['nova-web'], since: T0 });
    expect(r.next).toEqual({ status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web'] });
  });

  it('sigue caído por lo mismo dentro de la hora: NO repite el aviso (no spamear)', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web'] };
    const r = decide(down, ['nova-web'], T0 + 30 * MIN);
    expect(r.alert).toBeNull();
    expect(r.next).toEqual(down);
  });

  it('sigue caído pasada la hora: recuerda con still_down y reinicia el reloj', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web'] };
    const r = decide(down, ['nova-web'], T0 + 61 * MIN);
    expect(r.alert).toEqual({ kind: 'still_down', failing: ['nova-web'], since: T0 });
    expect(r.next.lastAlertAt).toBe(T0 + 61 * MIN);
    expect(r.next.since).toBe(T0);
  });

  it('cae OTRO componente mientras ya había uno caído: avisa de inmediato con la lista completa', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web'] };
    const r = decide(down, ['nova-web', 'channels-api'], T0 + 5 * MIN);
    expect(r.alert?.kind).toBe('down');
    expect(r.alert?.failing).toEqual(['channels-api', 'nova-web']);
    expect(r.next.since).toBe(T0);
  });

  it('se recupera: avisa una vez y vuelve a sano', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web'] };
    const r = decide(down, [], T0 + 25 * MIN);
    expect(r.alert).toEqual({ kind: 'recovered', failing: [], since: T0 });
    expect(r.next).toEqual({ status: 'ok', since: null, lastAlertAt: null, failing: [] });
    expect(decide(r.next, [], T0 + 30 * MIN).alert).toBeNull();
  });

  it('un componente se recupera pero otro sigue caído: no dice "recuperado" todavía', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['nova-web', 'channels-api'] };
    const r = decide(down, ['channels-api'], T0 + 10 * MIN);
    expect(r.alert).toBeNull();
    expect(r.next.failing).toEqual(['channels-api']);
  });

  it('el orden de los componentes no cambia la decisión', () => {
    const down: WatchState = { status: 'down', since: T0, lastAlertAt: T0, failing: ['channels-api', 'nova-web'] };
    expect(decide(down, ['nova-web', 'channels-api'], T0 + MIN).alert).toBeNull();
  });
});

describe('watchdog · mensajes', () => {
  const clean = (s: string) => {
    expect(s.trim().length).toBeGreaterThan(0);
    expect(s).not.toMatch(/[\n\t]/);
    expect(s).not.toMatch(/ {5,}/);
  };

  it('aviso de caída: plantilla P0 con 5 variables limpias y botón; texto de respaldo nombra lo caído', () => {
    const m = compose({ kind: 'down', failing: ['nova-web', 'channels-api'], since: T0 }, T0);
    expect(m.template.name).toBe('nova_founder_alert_p0_es_co_v1');
    expect(m.template.language).toBe('es_CO');
    expect(m.template.bodyParams).toHaveLength(5);
    m.template.bodyParams.forEach(clean);
    clean(m.template.buttonParam);
    expect(m.text).toMatch(/NOVA/);
    expect(m.text).toMatch(/nova-web/);
    expect(m.text).toMatch(/channels-api/);
  });

  it('recordatorio: dice cuánto lleva caído', () => {
    const m = compose({ kind: 'still_down', failing: ['nova-web'], since: T0 }, T0 + 95 * MIN);
    expect(m.text).toMatch(/1 h 35 min/);
    m.template.bodyParams.forEach(clean);
  });

  it('recuperado: texto claro y duración; la plantilla de respaldo no pide acción urgente', () => {
    const m = compose({ kind: 'recovered', failing: [], since: T0 }, T0 + 25 * MIN);
    expect(m.text).toMatch(/recuper/i);
    expect(m.text).toMatch(/25 min/);
    m.template.bodyParams.forEach(clean);
    expect(m.template.name).toBe('nova_founder_alert_p1_es_co_v1');
    expect(m.template.bodyParams).toHaveLength(3);
  });

  it('nunca incluye nada que parezca una credencial o una URL con token', () => {
    const m = compose({ kind: 'down', failing: ['nova-web'], since: T0 }, T0);
    const all = [m.text, ...m.template.bodyParams, m.template.buttonParam].join(' ');
    expect(all).not.toMatch(/EAA[A-Za-z0-9]{10,}|Bearer|token=|sk-/i);
  });
});
