# nexum-watchdog

Vigilante externo de NOVA. Cada 5 minutos revisa que el gateway de WhatsApp y NOVA respondan; si algo falla dos veces seguidas, le escribe al fundador **por WhatsApp**, directo a la API de Meta.

Vive fuera de Render a propósito: si Render se cae, este vigilante sigue funcionando y avisa. Solo avisa, no repara nada.

## Qué mide

| Servicio | Dirección | Es "sano" cuando |
|---|---|---|
| `channels-api` | `https://nexum-channels-api.onrender.com/readyz` | HTTP 200, `ok: true` y webhook listo |
| `nova-web` | `https://nexum-nova-web.onrender.com/readyz` | HTTP 200 y `ready`, `llm` y `channels` en `true` (la voz no cuenta) |

Limitación conocida: `llm: true` solo dice que la llave existe, no que el modelo conteste. Mientras `/readyz` no haga una llamada real al modelo, el vigilante no la detecta.

## Cuándo avisa

- **Caída:** una vez, con plantilla P0 (`nova_founder_alert_p0_es_co_v1`). Si la plantilla no está aprobada, intenta texto libre, que solo entra si el fundador escribió en las últimas 24 h.
- **Sigue caído:** un recordatorio por hora, no cada 5 minutos.
- **Cae otro componente:** aviso inmediato con la lista completa.
- **Recuperado:** una vez.
- Si no logra avisar por ninguna vía, la ejecución queda en rojo y GitHub escribe al dueño del repo por correo. Se reintenta en la siguiente ejecución.

## Secretos (Settings → Secrets and variables → Actions)

| Nombre | Qué es |
|---|---|
| `WATCHDOG_META_TOKEN` | Token permanente del usuario del sistema con `whatsapp_business_messaging` sobre la cuenta de WhatsApp de NOVA |
| `WATCHDOG_PHONE_NUMBER_ID` | `1366557866539502` (número de NOVA) |
| `WATCHDOG_TO` | Número del fundador, solo dígitos: `573204297359` |

Si se rota el token de NOVA, hay que actualizarlo aquí también.

## Probar el aviso

Actions → watchdog → Run workflow → en `simulate` escribir `nova-web` (o `channels-api`). Manda un aviso real de caída; al correr sin `simulate`, manda el de recuperado.

Sin enviar nada, en local: `npm run watch:dry`.

## Desarrollo

```
npm install
npm test
npm run typecheck
```
