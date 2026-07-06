# ai-sre-agent

Webhook que, al recibir un body con un error/alerta, lanza un **flujo agéntico
de análisis de causas raíz (RCA)** usando un modelo local de **Ollama**
(`qwen3:8b` por defecto). Sin dependencias externas: solo Node.js.

## Flujo agéntico

El body entrante pasa por una cadena de 3 pasos, cada uno alimenta al siguiente:

1. **Triage** — normaliza el error, extrae servicio, tipo, severidad y señales clave.
2. **Hipótesis** — genera las causas raíz más probables, ordenadas por confianza.
3. **Plan** — propone pasos de diagnóstico, mitigaciones rápidas y datos a recolectar.

## Requisitos

- Node.js >= 20 (usa `fetch` y `http` nativos)
- Ollama corriendo en local con un modelo descargado:
  ```
  ollama pull qwen3:8b
  ```

## Uso

```bash
npm start            # arranca el servidor en http://localhost:3000
npm run dashboard    # arranca el dashboard en http://localhost:4000
npm run test:webhook # envia un error de ejemplo y muestra el informe
```

Llamada manual:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"service":"checkout-api","level":"error","message":"connection timeout to db"}'
```

## Configuración (variables de entorno)

| Variable         | Por defecto              | Descripción                                  |
|------------------|--------------------------|----------------------------------------------|
| `PORT`           | `3000`                   | Puerto del servidor                          |
| `WEBHOOK_PATH`   | `/webhook`               | Ruta del webhook                             |
| `WEBHOOK_TOKEN`  | *(vacío)*                | Si se define, exige header `X-Webhook-Token` |
| `OLLAMA_HOST`    | `http://localhost:11434` | Servidor de Ollama                           |
| `OLLAMA_MODEL`   | `qwen3:8b`               | Modelo a usar                                |

## Endpoints

- `POST /webhook` — recibe el body (JSON o texto) y devuelve el informe RCA.
- `GET /health` — healthcheck.

## Dashboard

Un servidor aparte (`dashboard.js`, sin dependencias) sirve un frontend sencillo
para revisar los informes guardados en `reports/`:

```bash
npm run dashboard    # http://localhost:4000
```

Muestra la cantidad de informes generados y, por cada uno, el nombre de la API
(`triage.service`), la hora de creación y un badge de severidad. Al expandir una
fila se ve la **causa más probable** (la de mayor `confidence`), el **plan de
acción** y un botón **«Implementar fix»**.

El botón registra la **decisión** de implementar el fix del informe (queda
persistida en el propio `.json` bajo `implementation`). Hoy es un *scaffold*: el
caso de uso (`implement.js`) todavía **no lleva a cabo** la implementación real
(generar el parche y abrir un PR); eso llega en una próxima iteración. Ver el
roadmap en `rca-lab/docs/ESTADO.md § Próximos pasos`.

| Variable         | Por defecto | Descripción                       |
|------------------|-------------|-----------------------------------|
| `DASHBOARD_PORT` | `4000`      | Puerto del dashboard              |
| `REPORTS_DIR`    | `./reports` | Carpeta de informes que lee       |

Endpoints del dashboard:

- `GET /` — el dashboard (HTML).
- `GET /api/reports` — resumen JSON de los informes, ordenado por fecha desc.
- `POST /api/reports/{id}/implement` — caso de uso «implementar fix»: registra la
  decisión en el informe y devuelve su estado. Hoy responde `status: "pending"`
  (la ejecución real llega más adelante). `id` es el nombre de fichero del informe;
  se valida contra path traversal.

## Respuesta

```jsonc
{
  "ok": true,
  "generated_at": "...",
  "duration_ms": 8123,
  "triage": { "service": "...", "severity": "high", "key_signals": ["..."] },
  "probable_causes": [
    { "cause": "...", "confidence": 0.8, "category": "infra", "reasoning": "..." }
  ],
  "action_plan": {
    "next_steps": ["..."],
    "quick_mitigations": ["..."],
    "data_to_collect": ["..."]
  }
}
```
