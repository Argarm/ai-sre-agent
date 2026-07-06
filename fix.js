// Helpers para LLEVAR A CABO el fix de un informe RCA: clonar el repo, pedirle al
// LLM el archivo corregido, aplicarlo y (con token) abrir un Pull Request.
//
// Seguridad:
//   - Solo se opera sobre hosts de una allowlist (por defecto github.com).
//   - git se invoca con execFile (array de args, sin shell) -> sin inyeccion.
//   - El archivo a modificar que propone el LLM se valida DENTRO del repo clonado
//     (sin path traversal).
//   - El token nunca se registra: se depura de cualquier mensaje de error.
//   - Nunca se hace merge: solo se abre el PR para revision humana.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatJson } from "./ollama.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIX_WORKDIR =
  process.env.FIX_WORKDIR || path.join(__dirname, "work-fix");

const ALLOWED_HOSTS = (process.env.REPO_ALLOWED_HOSTS || "github.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const CLONE_TIMEOUT_MS = Number(process.env.REPO_CLONE_TIMEOUT_MS || 60000);
const GIT_AUTHOR_NAME = process.env.FIX_GIT_NAME || "ai-sre-agent";
const GIT_AUTHOR_EMAIL = process.env.FIX_GIT_EMAIL || "ai-sre-agent@localhost";

// Ejecucion de la suite de tests en el clon para verificar el "antes/despues".
const TEST_TIMEOUT_MS = Number(process.env.FIX_TEST_TIMEOUT_MS || 120000);
// auto: ejecuta si detecta runner disponible; off: nunca ejecuta (modo documentado).
const TEST_RUN_MODE = (process.env.FIX_TEST_RUN || "auto").toLowerCase();

// --- Parseo/validacion del repo ---------------------------------------------

// Acepta la URL del repo (code_context.repo). Devuelve { owner, repo, host } o
// null si no es https, el host no esta permitido, o el path no es owner/repo.
export function parseGitHubRepo(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") return null;
  let u;
  try {
    u = new URL(repoUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return null;

  const parts = u.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) {
    return null;
  }
  return { owner: parts[0], repo: parts[parts.length - 1], host };
}

// --- Clon de la rama por defecto --------------------------------------------

// Clona la rama por defecto del repo (el PR apunta a ella, no al commit del
// incidente). Con token, clona autenticado para poder hacer push despues.
export async function cloneDefaultBranch({ owner, repo, host, token }) {
  const dir = path.join(FIX_WORKDIR, `${owner}-${repo}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(FIX_WORKDIR, { recursive: true });

  const url = token
    ? `https://x-access-token:${token}@${host}/${owner}/${repo}.git`
    : `https://${host}/${owner}/${repo}.git`;

  try {
    await execFileP("git", ["clone", "--depth", "1", "--", url, dir], {
      timeout: CLONE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`git clone fallo: ${scrubToken(err.message, token)}`);
  }

  // Identidad local para poder commitear en este clon.
  await git(dir, ["config", "user.name", GIT_AUTHOR_NAME], token);
  await git(dir, ["config", "user.email", GIT_AUTHOR_EMAIL], token);

  const baseBranch = (
    await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], token)
  ).trim();
  const baseSha = (await git(dir, ["rev-parse", "HEAD"], token)).trim();
  return { dir, baseBranch, baseSha };
}

// --- Generacion del parche con el LLM ---------------------------------------

const FIX_SYSTEM = {
  role: "system",
  content:
    "Eres un ingeniero de software que corrige bugs con precision. Te basas " +
    "SOLO en el codigo real que se te muestra y en el informe de causa raiz. " +
    "Cambias lo minimo necesario para corregir el bug, conservando el estilo. " +
    "Respondes EXCLUSIVAMENTE con el JSON que se te pide, sin texto extra.",
};

// Pide al LLM el archivo a corregir y EDICIONES QUIRURGICAS (bloques old/new de
// coincidencia exacta), no el archivo entero: preserva docstrings, comentarios y
// el resto del codigo, y produce diffs minimos.
// Devuelve { file, new_content, edits, explanation, pr_title, pr_body } o lanza.
export async function proposeFix({ report, dir, files }) {
  const rca = rcaJson(report);
  const fileList = files.map((f) => f.path);

  // Paso 1: localizar el UNICO archivo a modificar (de la lista real).
  const located = await chatJson(
    [
      FIX_SYSTEM,
      {
        role: "user",
        content:
          "Dado este informe de causa raiz y la lista de archivos del repo, " +
          "indica el UNICO archivo que hay que modificar para corregir el bug.\n" +
          'Devuelve JSON: { "file": "<ruta EXACTA de la lista>", "rationale": "<breve>" }.\n\n' +
          "RCA:\n" + rca + "\n\nARCHIVOS:\n" + fileList.join("\n"),
      },
    ],
    { temperature: 0.1 },
  );

  const file = typeof located?.file === "string" ? located.file.trim() : "";
  if (!fileList.includes(file)) {
    throw new Error(
      `el LLM propuso un archivo fuera de la lista del repo: ${JSON.stringify(located?.file)}`,
    );
  }

  const abs = safeJoin(dir, file);
  if (!abs) throw new Error(`ruta de archivo no segura: ${file}`);
  const current = await fs.readFile(abs, "utf8");

  // Paso 2: pedir EDICIONES quirurgicas (bloques old/new), no el archivo entero.
  const patched = await chatJson(
    [
      FIX_SYSTEM,
      {
        role: "user",
        content:
          "Corrige el bug del RCA con el MINIMO de ediciones sobre este archivo.\n" +
          'Devuelve JSON: { "edits": [ { "old": "<fragmento del archivo actual>", ' +
          '"new": "<su reemplazo>" } ], ' +
          '"explanation": "<que cambiaste y por que, 1-3 frases>", ' +
          '"pr_title": "<titulo tipo conventional commit, p.ej. fix: ...>", ' +
          '"pr_body": "<markdown breve describiendo el fix>" }.\n' +
          "Reglas de 'old': copialo TAL CUAL del archivo (mismos espacios, indentacion " +
          "y saltos de linea); debe aparecer UNA sola vez; incluye lo justo para ubicarlo " +
          "sin ambiguedad. NO devuelvas el archivo completo. Usa varias ediciones si hace falta.\n\n" +
          "RCA:\n" + rca +
          `\n\nARCHIVO ${file} (contenido actual):\n` + current,
      },
    ],
    { temperature: 0.1 },
  );

  const edits = Array.isArray(patched?.edits) ? patched.edits : [];
  if (edits.length === 0) {
    throw new Error("el LLM no devolvio ediciones ('edits') para el fix");
  }

  // Aplicamos las ediciones por coincidencia EXACTA y UNICA (falla si no encaja):
  // preferimos fallar claro antes que reescribir el archivo y perder contexto.
  const newContent = applyEdits(current, edits);

  return {
    file,
    new_content: newContent,
    edits: edits.length,
    explanation: String(patched.explanation || "").trim(),
    pr_title: String(patched.pr_title || `fix: corrige ${file}`).trim().slice(0, 120),
    pr_body: String(patched.pr_body || "").trim(),
  };
}

// Aplica ediciones { old, new } sobre el contenido, exigiendo que cada 'old'
// aparezca EXACTAMENTE UNA vez. Normaliza los saltos de linea de old/new al EOL
// del archivo, para no ensuciar el diff con cambios CRLF<->LF. Lanza si algun
// fragmento no encaja o es ambiguo, o si el resultado no cambia nada.
function applyEdits(content, edits) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const toEol = (s) => s.replace(/\r\n/g, "\n").split("\n").join(eol);

  let out = content;
  edits.forEach((e, i) => {
    if (!e || typeof e.old !== "string" || typeof e.new !== "string") {
      throw new Error(`edicion ${i + 1} invalida: 'old' y 'new' deben ser strings`);
    }
    if (e.old === "") throw new Error(`edicion ${i + 1}: 'old' esta vacio`);

    const oldS = toEol(e.old);
    const newS = toEol(e.new);
    const idx = out.indexOf(oldS);
    if (idx === -1) {
      throw new Error(
        `edicion ${i + 1}: el fragmento 'old' no se encontro en el archivo (se requiere copia exacta)`,
      );
    }
    if (out.indexOf(oldS, idx + oldS.length) !== -1) {
      throw new Error(
        `edicion ${i + 1}: el fragmento 'old' es ambiguo (aparece mas de una vez)`,
      );
    }
    out = out.slice(0, idx) + newS + out.slice(idx + oldS.length);
  });

  if (out === content) throw new Error("las ediciones no cambian el archivo");
  return out;
}

// Escribe el contenido corregido y devuelve el diff. changed=false si es igual.
export async function applyFix({ dir, file, new_content }) {
  const abs = safeJoin(dir, file);
  if (!abs) throw new Error(`ruta de archivo no segura: ${file}`);
  await fs.writeFile(abs, new_content, "utf8");
  const diff = await git(dir, ["diff", "--", file]);
  return { changed: diff.trim().length > 0, diff };
}

// --- Test de regresion que respalda el fix ----------------------------------

// Pide al LLM un TEST DE REGRESION que reproduzca el bug: debe FALLAR contra el
// codigo actual (sin fix) y PASAR una vez aplicado el fix. Se le da el RCA, el
// archivo productivo a corregir y un test existente como muestra de estilo/framework.
// Devuelve { test_file, mode: "new"|"edit", content?, edits?, commit_subject, commit_body }.
export async function proposeRegressionTest({ report, dir, files, fixFile }) {
  const rca = rcaJson(report);
  const fileList = files.map((f) => f.path);
  const testPaths = fileList.filter((p) => /(^|\/)tests?\//i.test(p) || /(^|[._-])test/i.test(path.basename(p)));

  const prodContent = await readClipped(safeJoin(dir, fixFile), 8000);
  // Una muestra real de test del repo ancla framework, imports y convenciones.
  let sample = "";
  let sampleName = "";
  for (const p of testPaths) {
    const abs = safeJoin(dir, p);
    const c = abs ? await readClipped(abs, 3000) : "";
    if (c) { sample = c; sampleName = p; break; }
  }

  const proposed = await chatJson(
    [
      FIX_SYSTEM,
      {
        role: "user",
        content:
          "Escribe un TEST DE REGRESION que reproduzca el bug del RCA. El test DEBE " +
          "fallar contra el codigo ACTUAL (todavia sin corregir) y pasar cuando se aplique el fix.\n" +
          "Devuelve JSON:\n" +
          '{ "test_file": "<ruta del archivo de test: reutiliza una existente para AÑADIR el caso, ' +
          'o una ruta nueva coherente con la convencion del repo>",\n' +
          '  "mode": "new" | "edit",\n' +
          '  "content": "<archivo de test COMPLETO, solo si mode=new>",\n' +
          '  "edits": [ { "old": "<fragmento EXACTO del test existente>", "new": "<reemplazo con el caso nuevo>" } ],\n' +
          '  "commit_subject": "<conventional commit, p.ej. test: reproduce ...>",\n' +
          '  "commit_body": "<1-2 frases: que comportamiento cubre>" }\n' +
          "Reglas: usa el MISMO framework y estilo que la muestra. Si mode=edit, cada 'old' debe " +
          "copiarse TAL CUAL (aparece una sola vez). No modifiques codigo productivo aqui, solo el test.\n\n" +
          "RCA:\n" + rca +
          `\n\nARCHIVO PRODUCTIVO A CORREGIR (${fixFile}):\n` + prodContent +
          (sample ? `\n\nTEST EXISTENTE DE MUESTRA (${sampleName}):\n` + sample : "\n\n(No hay tests existentes de muestra.)"),
      },
    ],
    { temperature: 0.1 },
  );

  const testFile = typeof proposed?.test_file === "string" ? proposed.test_file.trim() : "";
  if (!testFile || !safeJoin(dir, testFile)) {
    throw new Error(`el LLM propuso una ruta de test no valida: ${JSON.stringify(proposed?.test_file)}`);
  }
  const mode = proposed?.mode === "edit" ? "edit" : "new";
  const subject = normalizeConventional(String(proposed?.commit_subject || "").trim(), "test", `añade test de regresion para ${fixFile}`);
  return {
    test_file: testFile,
    mode,
    content: typeof proposed?.content === "string" ? proposed.content : "",
    edits: Array.isArray(proposed?.edits) ? proposed.edits : [],
    commit_subject: subject,
    commit_body: String(proposed?.commit_body || "").trim(),
  };
}

// Materializa el test propuesto en el clon (crea el archivo o aplica las edits
// sobre uno existente). Devuelve { changed, diff }.
export async function applyRegressionTest({ dir, proposal }) {
  const abs = safeJoin(dir, proposal.test_file);
  if (!abs) throw new Error(`ruta de test no segura: ${proposal.test_file}`);

  if (proposal.mode === "edit") {
    if (proposal.edits.length === 0) throw new Error("el LLM no devolvio ediciones para el test existente");
    const current = await fs.readFile(abs, "utf8");
    await fs.writeFile(abs, applyEdits(current, proposal.edits), "utf8");
  } else {
    if (!proposal.content.trim()) throw new Error("el LLM no devolvio contenido para el test nuevo");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, proposal.content, "utf8");
  }

  const diff = await git(dir, ["diff", "--", proposal.test_file]);
  const staged = diff.trim().length > 0;
  // Para archivos NUEVOS `git diff` no muestra nada hasta stagear: comprobamos con status.
  if (!staged) {
    const status = await git(dir, ["status", "--porcelain", "--", proposal.test_file]);
    return { changed: status.trim().length > 0, diff: status };
  }
  return { changed: true, diff };
}

// --- Deteccion y ejecucion de la suite de tests -----------------------------

// Decide con que comando ejecutar los tests del repo clonado, en funcion de los
// archivos presentes, y comprueba que el runtime este realmente disponible en
// PATH. Devuelve { available, cmd, args, label, reason }. `available:false` NO es
// un error: significa "no se pudo ejecutar aqui" -> se cae a modo documentado.
export async function detectTestRunner({ dir, files }) {
  if (TEST_RUN_MODE === "off") {
    return { available: false, reason: "ejecucion de tests desactivada (FIX_TEST_RUN=off)" };
  }
  const paths = (files || []).map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
  const has = (p) => paths.includes(p);
  const some = (re) => paths.some((p) => re.test(p));

  // Node: package.json con script "test" real (no el placeholder de npm init).
  if (has("package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(await fs.readFile(safeJoin(dir, "package.json"), "utf8"));
    } catch {
      /* package.json ilegible: seguimos con las demas heuristicas */
    }
    const testScript = pkg?.scripts?.test;
    const isPlaceholder = !testScript || /no test specified/i.test(testScript);
    if (!isPlaceholder && (await commandWorks("npm", ["--version"]))) {
      return { available: true, cmd: "npm", args: ["test", "--silent"], label: `npm test (${testScript})` };
    }
  }

  // Python: pytest si hay marcadores de proyecto o tests con su convencion.
  const looksPy =
    has("pyproject.toml") || has("requirements.txt") || has("pytest.ini") ||
    has("setup.cfg") || some(/(^|\/)tests?\/.*\.py$/i) || some(/(^|\/)test_[^/]+\.py$/i);
  if (looksPy) {
    if (await commandWorks("pytest", ["--version"])) {
      return { available: true, cmd: "pytest", args: ["-q"], label: "pytest -q" };
    }
    if (await commandWorks("python", ["-m", "pytest", "--version"])) {
      return { available: true, cmd: "python", args: ["-m", "pytest", "-q"], label: "python -m pytest -q" };
    }
    return { available: false, reason: "proyecto Python detectado pero pytest no esta en PATH" };
  }

  return { available: false, reason: "no se reconocio un runner de tests soportado (npm/pytest)" };
}

// Ejecuta el runner en el clon. NO lanza por tests en rojo: un exit != 0 es un
// resultado legitimo. Clasifica en pass | fail | inconclusive (esto ultimo cuando
// el fallo es del entorno -deps ausentes, import errors, timeout-, no del test).
export async function runTests({ dir, runner }) {
  if (!runner || !runner.available) {
    return { ran: false, status: "inconclusive", output: "", reason: runner?.reason || "sin runner" };
  }
  try {
    const { stdout, stderr } = await execFileP(runner.cmd, runner.args, {
      cwd: dir,
      timeout: TEST_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ran: true, status: "pass", code: 0, output: clip(stdout + stderr) };
  } catch (err) {
    const output = clip((err.stdout || "") + (err.stderr || "") + (err.stdout || err.stderr ? "" : err.message));
    if (err.killed) {
      return { ran: true, status: "inconclusive", output, reason: `timeout tras ${TEST_TIMEOUT_MS} ms` };
    }
    if (isEnvFailure(output)) {
      return { ran: true, status: "inconclusive", output, reason: "fallo de entorno (dependencias/importacion)" };
    }
    return { ran: true, status: "fail", code: typeof err.code === "number" ? err.code : 1, output };
  }
}

// Señales de que el fallo NO es un test en rojo sino un problema del entorno.
function isEnvFailure(output) {
  return /ModuleNotFoundError|No module named|ImportError|ERROR collecting|no tests ran|Cannot find module|missing script: test|command not found|is not recognized/i.test(
    output,
  );
}

// Comprueba que un comando existe y responde (p.ej. `--version`) sin lanzar.
async function commandWorks(cmd, args) {
  try {
    await execFileP(cmd, args, { timeout: 15000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function clip(s, max = 4000) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max) + "\n… (salida recortada)" : str;
}

// --- Apertura del Pull Request ----------------------------------------------

// Crea rama, commitea el archivo, hace push con el token y abre el PR via API.
// Devuelve { branch, pr_url, pr_number }. Lanza (con token depurado) si falla.
export async function openPullRequest({
  owner, repo, host, token, dir, baseBranch, file, pr_title, pr_body, explanation,
}) {
  const branch = `ai-sre-agent/fix-${Date.now().toString(36)}`;
  const body =
    (pr_body ? pr_body + "\n\n" : "") +
    (explanation ? `**Cambio:** ${explanation}\n\n` : "") +
    "_PR generado automaticamente por ai-sre-agent a partir de un informe RCA. " +
    "Requiere revision humana; no se auto-mergea._";

  await git(dir, ["checkout", "-b", branch], token);
  await git(dir, ["add", "--", file], token);
  await git(
    dir,
    ["commit", "-m", pr_title, "-m", explanation || "fix automatico"],
    token,
  );

  const pushUrl = `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
  await git(dir, ["push", pushUrl, `${branch}:${branch}`], token);

  const pr = await createPullRequestApi({
    owner, repo, host, token, title: pr_title, head: branch, base: baseBranch, body,
  });
  return { branch, pr_url: pr.html_url, pr_number: pr.number };
}

// POST a la API REST de GitHub para crear el PR.
async function createPullRequestApi({ owner, repo, host, token, title, head, base, body }) {
  const api =
    host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const res = await fetch(`${api}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ai-sre-agent",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, head, base, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    const detail = Array.isArray(data?.errors)
      ? " (" + data.errors.map((e) => e.message || JSON.stringify(e)).join("; ") + ")"
      : "";
    throw new Error(`la API de GitHub rechazo el PR: ${msg}${detail}`);
  }
  return data;
}

// --- utilidades -------------------------------------------------------------

// Serializa las partes del informe RCA que necesita el LLM para razonar el fix.
function rcaJson(report) {
  return JSON.stringify(
    {
      triage: report.triage,
      probable_causes: report.probable_causes,
      action_plan: report.action_plan,
    },
    null,
    2,
  );
}

// Lee un archivo y recorta a `max` chars para acotar el prompt. "" si no existe.
async function readClipped(abs, max) {
  if (!abs) return "";
  try {
    const c = await fs.readFile(abs, "utf8");
    return c.length > max ? c.slice(0, max) + "\n… (recortado)" : c;
  } catch {
    return "";
  }
}

// Garantiza que el asunto siga Conventional Commits del `type` dado. Si el LLM ya
// devolvio un asunto con un prefijo valido (feat/fix/test/…), lo respeta; si no,
// antepone `${type}: ` a un fallback. Recorta a 100 chars (cabecera recomendada).
function normalizeConventional(subject, type, fallback) {
  const s = (subject || "").split("\n")[0].trim();
  const hasType = /^(feat|fix|test|refactor|chore|docs|perf|build|ci|style|revert)(\([^)]*\))?!?:\s/.test(s);
  const out = s && hasType ? s : `${type}: ${s || fallback}`;
  return out.slice(0, 100);
}

// Ejecuta git en el repo clonado; devuelve stdout. Depura el token de errores.
async function git(dir, args, token) {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, ...args], {
      timeout: CLONE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw new Error(scrubToken(err.message, token));
  }
}

// Resuelve dir/rel asegurando que queda DENTRO de dir (anti path traversal).
function safeJoin(dir, rel) {
  const abs = path.resolve(dir, rel);
  const root = path.resolve(dir);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Elimina el token de un string (para no filtrarlo en logs/errores).
function scrubToken(str, token) {
  let s = String(str ?? "");
  if (token) s = s.split(token).join("***");
  // Por si aparece embebido en una URL con credenciales.
  return s.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
