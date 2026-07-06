// Servidor del dashboard de informes RCA. Independiente de server.js.
// Sin dependencias externas: solo el modulo http nativo.
//
//   GET /              -> sirve el dashboard (public/index.html).
//   GET /api/reports   -> lista los informes de REPORTS_DIR (resumen JSON).
//
// Arranca con:  npm run dashboard   (o  node dashboard.js)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { implementFix } from "./implement.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.DASHBOARD_PORT || 4000);
// Bind a 0.0.0.0 por defecto, igual que server.js (ver nota alli sobre k3d).
const HOST = process.env.HOST || "0.0.0.0";
// Misma carpeta de informes que usa server.js para persistirlos.
const REPORTS_DIR =
  process.env.REPORTS_DIR || path.join(__dirname, "reports");
const INDEX_HTML = path.join(__dirname, "public", "index.html");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      return serveIndex(res);
    }

    if (req.method === "GET" && req.url === "/api/reports") {
      const reports = await listReports();
      return json(res, 200, reports);
    }

    // Caso de uso "implementar el fix" de un informe. Hoy delega en un stub
    // (implement.js) que registra la decisión; la ejecución real llega despues.
    if (
      req.method === "POST" &&
      req.url.startsWith("/api/reports/") &&
      req.url.endsWith("/implement")
    ) {
      const id = decodeURIComponent(
        req.url.slice("/api/reports/".length, -"/implement".length),
      );
      return handleImplement(res, id);
    }

    return json(res, 404, { ok: false, error: "ruta no encontrada" });
  } catch (err) {
    log(`ERROR: ${err.stack || err.message}`);
    return json(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  log(`dashboard escuchando en ${HOST}:${PORT}`);
  log(`Reports:   ${REPORTS_DIR}`);
  log(`Dashboard: http://localhost:${PORT}/`);
});

// --- helpers -----------------------------------------------------------

// Sirve el HTML del dashboard. Si no existe el fichero, responde un 500 claro.
async function serveIndex(res) {
  try {
    const html = await fs.readFile(INDEX_HTML);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    log(`ERROR sirviendo index.html: ${err.message}`);
    json(res, 500, { ok: false, error: "no se pudo cargar el dashboard" });
  }
}

// Lee REPORTS_DIR, parsea cada .json y devuelve un resumen por informe,
// ordenado por generated_at descendente (mas recientes primero). Los ficheros
// corruptos o no parseables se ignoran para no tumbar la respuesta.
async function listReports() {
  let files;
  try {
    files = await fs.readdir(REPORTS_DIR);
  } catch {
    return []; // carpeta inexistente todavia: sin informes
  }

  const reports = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(REPORTS_DIR, name), "utf8");
      const data = JSON.parse(raw);
      reports.push(summarize(name, data));
    } catch (err) {
      log(`AVISO: ignorando informe ilegible ${name}: ${err.message}`);
    }
  }

  reports.sort((a, b) =>
    String(b.generated_at || "").localeCompare(String(a.generated_at || "")),
  );
  return reports;
}

// Recorta un informe completo al resumen que consume el dashboard.
function summarize(id, report) {
  const triage = report?.triage || {};
  const causes = Array.isArray(report?.probable_causes)
    ? report.probable_causes
    : [];
  return {
    id,
    service: triage.service || "unknown",
    severity: triage.severity || null,
    generated_at: report?.generated_at || null,
    duration_ms: report?.duration_ms ?? null,
    top_cause: topCause(causes),
    action_plan: report?.action_plan || null,
    implementation: report?.implementation || null,
  };
}

// Resuelve el fichero de un informe a partir de su id (nombre de fichero),
// blindando contra path traversal: exige un basename plano y con extension .json
// dentro de REPORTS_DIR. Devuelve null si el id no es valido.
function safeReportPath(id) {
  const base = path.basename(String(id || ""));
  if (base !== id || !base.endsWith(".json")) return null;
  return path.join(REPORTS_DIR, base);
}

// Endpoint "implementar fix": carga el informe, invoca el caso de uso
// (implement.js) y persiste la decision + resultado en el propio informe, para
// que el dashboard refleje que la implementacion ya fue solicitada.
async function handleImplement(res, id) {
  const file = safeReportPath(id);
  if (!file) {
    return json(res, 400, { ok: false, error: "id de informe invalido" });
  }

  let report;
  try {
    report = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return json(res, 404, { ok: false, error: "informe no encontrado" });
  }

  // El caso de uso no debe lanzar; aun asi lo envolvemos por robustez.
  let outcome;
  try {
    outcome = await implementFix({ id, report });
  } catch (err) {
    log(`ERROR en implementFix(${id}): ${err.message}`);
    outcome = { status: "failed", message: String(err.message || err), fix: null };
  }

  const implementation = {
    requested_at: new Date().toISOString(),
    status: outcome.status,
    message: outcome.message,
    fix: outcome.fix ?? null,
  };

  // Persistimos la decision en el informe (best-effort: si falla la escritura,
  // devolvemos igualmente el resultado del caso de uso).
  try {
    report.implementation = implementation;
    await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8");
  } catch (err) {
    log(`AVISO: no se pudo persistir la decision en ${id}: ${err.message}`);
  }

  log(`Implementacion solicitada para ${id} -> ${outcome.status}`);
  return json(res, 200, { ok: true, id, implementation });
}

// Devuelve la causa con mayor confidence (la mas probable), o null si no hay.
// El array ya suele venir ordenado, pero calculamos el maximo por robustez.
function topCause(causes) {
  if (causes.length === 0) return null;
  let best = causes[0];
  for (const c of causes) {
    if (Number(c?.confidence ?? 0) > Number(best?.confidence ?? 0)) best = c;
  }
  return {
    cause: best?.cause ?? "",
    confidence: Number(best?.confidence ?? 0),
    category: best?.category ?? null,
    reasoning: best?.reasoning ?? "",
  };
}

function json(res, status, obj) {
  const data = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
