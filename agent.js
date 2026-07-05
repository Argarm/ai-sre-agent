// Flujo agentico de analisis de causas (root cause analysis).
//
// Recibe un payload de error arbitrario (el body del webhook) y ejecuta
// una cadena de razonamiento en 3 pasos contra el modelo local:
//
//   1. Triage    -> normaliza y extrae la senal del error.
//   2. Hipotesis -> genera causas probables, ordenadas por confianza.
//   3. Plan      -> propone pasos de diagnostico/mitigacion accionables.
//
// Cada paso alimenta al siguiente, de ahi el caracter "agentico".

import { chatJson } from "./ollama.js";
import { fetchRepoContext } from "./repo.js";

const SYSTEM = {
  role: "system",
  content:
    "Eres un SRE senior. Analizas incidentes y errores de produccion con " +
    "rigor tecnico. Respondes en espanol, de forma concisa y accionable. " +
    "No inventas datos: si algo no esta en el payload, lo marcas como suposicion. " +
    "Cuando se te proporcione el CODIGO FUENTE del servicio, basate en el codigo " +
    "real (funciones, ramas, excepciones que ves) y NO especules sobre bases de " +
    "datos, indices, concurrencia u otros componentes que no aparezcan en el.",
};

/**
 * Ejecuta el flujo completo sobre el body recibido en el webhook.
 * @param {any} payload  El body ya parseado (objeto) o texto crudo.
 * @returns {Promise<object>} informe estructurado.
 */
export async function analyzeIncident(payload) {
  const raw =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);

  const startedAt = Date.now();

  // --- Paso 0: Descargar el repo de origen (contexto de codigo) ---------
  // El enricher pone la URL del repo en 'repositorio' y (si esta) el commit
  // en 'commit'. Clonamos en una carpeta separada y recopilamos el codigo.
  // Si no hay repo o falla, seguimos sin contexto de codigo (no bloquea).
  const repoUrl = typeof payload === "object" && payload ? payload.repositorio : null;
  const repoRef = typeof payload === "object" && payload ? payload.commit : null;
  const code = await fetchRepoContext(repoUrl, { ref: repoRef });

  const codeBlock = code.ok
    ? `\n\nCODIGO FUENTE del servicio (repo ${code.repo}` +
      `${code.head ? ` @ ${code.head.slice(0, 12)}` : ""}, ${code.files.length} archivos):\n` +
      code.snippet
    : `\n\n(No hay codigo fuente disponible: ${code.reason}. Analiza solo con el payload y marca como suposicion todo lo que no puedas confirmar.)`;

  // --- Paso 1: Triage --------------------------------------------------
  const triage = await chatJson(
    [
      SYSTEM,
      {
        role: "user",
        content:
          "Analiza este payload de error/alerta y extrae la senal principal.\n" +
          "Devuelve JSON con las claves: service (string), summary (string), " +
          "error_type (string), severity (uno de: low|medium|high|critical), " +
          "key_signals (array de strings con los datos mas relevantes).\n\n" +
          "PAYLOAD:\n" +
          raw,
      },
    ],
    { temperature: 0.1 },
  );

  // --- Paso 2: Hipotesis de causas -------------------------------------
  const hypotheses = await chatJson(
    [
      SYSTEM,
      {
        role: "user",
        content:
          "Dado este triage de un incidente, enumera las causas raiz mas " +
          "probables. Devuelve JSON con la clave 'causes': un array de objetos " +
          "con { cause (string), confidence (0-1), reasoning (string), " +
          "category (uno de: code|config|infra|dependency|data|network|unknown) }.\n" +
          "Ordena de mayor a menor confianza. Maximo 5.\n" +
          "Si tienes el codigo fuente, apoya cada causa en el codigo real " +
          "(cita archivo/funcion) y prioriza el bug que veas en el.\n\n" +
          "TRIAGE:\n" +
          JSON.stringify(triage, null, 2) +
          "\n\nPAYLOAD ORIGINAL:\n" +
          raw +
          codeBlock,
      },
    ],
    { temperature: 0.3 },
  );

  // --- Paso 3: Plan de diagnostico -------------------------------------
  const plan = await chatJson(
    [
      SYSTEM,
      {
        role: "user",
        content:
          "En base a estas causas probables, propone un plan de accion. " +
          "Devuelve JSON con: next_steps (array de strings, pasos de diagnostico " +
          "en orden), quick_mitigations (array de strings), " +
          "data_to_collect (array de strings: logs/metricas que confirmarian la causa).\n" +
          "Si hay un fix claro en el codigo, incluyelo en quick_mitigations citando " +
          "archivo/funcion.\n\n" +
          "CAUSAS:\n" +
          JSON.stringify(hypotheses, null, 2) +
          codeBlock,
      },
    ],
    { temperature: 0.3 },
  );

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    // Trazabilidad del contexto de codigo usado (o por que no lo hubo).
    code_context: code.ok
      ? { repo: code.repo, ref: code.ref, head: code.head, cloned_to: code.dir, files: code.files }
      : { available: false, reason: code.reason },
    triage,
    probable_causes: hypotheses.causes ?? hypotheses,
    action_plan: plan,
  };
}
