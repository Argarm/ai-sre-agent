// Servidor de webhook. Sin dependencias externas: usa el modulo http nativo.
//
//   POST /webhook   -> recibe el body y lanza el flujo agentico de RCA.
//   GET  /health    -> healthcheck (comprueba tambien Ollama).
//
// Arranca con:  npm start   (o  node server.js)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeIncident } from "./agent.js";
import { config } from "./ollama.js";

const PORT = Number(process.env.PORT || 3000);
// Interfaz de escucha. Por defecto 0.0.0.0 (todas): imprescindible para que un
// pod del cluster k3d alcance el webhook por host.k3d.internal, cuya IP es IPv4
// y un bind al default de Node en Windows ("::", IPv6-only) la rechaza.
const HOST = process.env.HOST || "0.0.0.0";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
// Token opcional. Si se define, el webhook exige header X-Webhook-Token.
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const MAX_BODY_BYTES = 1_000_000; // 1 MB
// Carpeta donde se persiste cada informe generado (un .json por incidente).
const REPORTS_DIR =
  process.env.REPORTS_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "reports");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, model: config.OLLAMA_MODEL });
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      if (WEBHOOK_TOKEN && req.headers["x-webhook-token"] !== WEBHOOK_TOKEN) {
        return json(res, 401, { ok: false, error: "token invalido" });
      }

      const body = await readBody(req);
      if (body === null) {
        return json(res, 413, { ok: false, error: "body demasiado grande" });
      }

      const payload = tryParseJson(body);
      log(`Webhook recibido (${Buffer.byteLength(body)} bytes). Aceptado; procesando en background...`);

      // Ack asincrono: respondemos 202 de inmediato y ejecutamos el RCA en
      // background. El flujo (clon del repo + varios pasos LLM) tarda mas que
      // el timeout del enricher (~10s); sin esto el enricher loguearia un
      // falso "Fallo el reenvio" aunque el informe se genere y guarde igual.
      json(res, 202, { ok: true, accepted: true, message: "analisis en curso" });

      processIncident(payload);
      return;
    }

    return json(res, 404, { ok: false, error: "ruta no encontrada" });
  } catch (err) {
    log(`ERROR: ${err.stack || err.message}`);
    return json(res, 500, { ok: false, error: String(err.message || err) });
  }
});

await fs.mkdir(REPORTS_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  log(`ai-sre-agent escuchando en ${HOST}:${PORT}`);
  log(`Reports:  ${REPORTS_DIR}`);
  log(`Webhook:  POST http://localhost:${PORT}${WEBHOOK_PATH}`);
  log(`Modelo:   ${config.OLLAMA_MODEL} @ ${config.OLLAMA_HOST}`);
  if (WEBHOOK_TOKEN) log("Auth:     header X-Webhook-Token requerido");
});

// --- helpers -----------------------------------------------------------

// Ejecuta el RCA y persiste el informe. Se lanza DESPUES de enviar el 202
// (fire-and-forget), por lo que nunca debe propagar: cualquier fallo se
// registra en el log y no afecta a la respuesta ya enviada.
async function processIncident(payload) {
  try {
    const report = await analyzeIncident(payload);
    log(`Analisis completado en ${report.duration_ms} ms.`);
    const savedTo = await saveReport(report);
    if (savedTo) log(`Informe guardado en ${savedTo}`);
  } catch (err) {
    log(`ERROR en el analisis en background: ${err.stack || err.message}`);
  }
}

// Persiste el informe como un .json con timestamp + servicio en REPORTS_DIR.
// Nunca lanza: si falla la escritura, lo registra y devuelve null para no
// tumbar la respuesta del webhook.
async function saveReport(report) {
  try {
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("Z", "");
    const service = String(report?.triage?.service || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unknown";
    const file = path.join(REPORTS_DIR, `${stamp}_${service}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8");
    return file;
  } catch (err) {
    log(`ERROR guardando informe: ${err.message}`);
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return resolve(null);
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tryParseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text; // se pasa como texto crudo al agente
  }
}

function json(res, status, obj) {
  const data = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
