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
  const rca = JSON.stringify(
    {
      triage: report.triage,
      probable_causes: report.probable_causes,
      action_plan: report.action_plan,
    },
    null,
    2,
  );
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
