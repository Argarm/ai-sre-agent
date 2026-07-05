// Descarga del repositorio de origen para dar CONTEXTO DE CODIGO al RCA.
//
// El enricher mete en el body la URL del repo (vcs.repository.url.full) y, si
// esta disponible, el commit (vcs.ref.head.revision). Aqui clonamos ese repo en
// una CARPETA SEPARADA de trabajo y recopilamos el codigo fuente para que el
// agente analice el codigo real junto al informe del enricher, en vez de
// alucinar sobre una implementacion que no ha visto.
//
// Seguridad: la URL viene del payload del webhook, asi que:
//   - solo aceptamos https y hosts de una allowlist (por defecto github.com),
//   - saneamos owner/repo y el ref antes de pasarlos a git,
//   - invocamos git con execFile (array de args, sin shell) -> sin inyeccion.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Carpeta separada donde se clonan los repos (una subcarpeta por repo).
const WORKDIR = process.env.REPO_WORKDIR || path.join(__dirname, "work");

// Hosts de los que aceptamos clonar. La URL es semi-confiable (viene del trace).
const ALLOWED_HOSTS = (process.env.REPO_ALLOWED_HOSTS || "github.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const CLONE_TIMEOUT_MS = Number(process.env.REPO_CLONE_TIMEOUT_MS || 60000);
const MAX_FILE_CHARS = 8000;    // recorte por archivo
const MAX_TOTAL_CHARS = 40000;  // presupuesto total del contexto de codigo

// Extensiones de codigo fuente que incluimos.
const SOURCE_EXT = new Set([
  ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".go", ".java", ".rb", ".rs",
  ".php", ".cs", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".sh",
]);
// Archivos por nombre exacto (config/manifiestos utiles para el RCA).
const SPECIAL_FILES = new Set([
  "Dockerfile", "requirements.txt", "package.json", "go.mod", "pom.xml",
  "Makefile", "pyproject.toml",
]);
// Directorios que nunca recorremos.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
  ".idea", ".vscode", ".pytest_cache", ".mypy_cache", "coverage",
]);

const isSha = (s) => /^[0-9a-f]{7,40}$/i.test(s);

function sanitizeRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  const r = ref.trim();
  // sha, o nombre de rama/tag conservador (sin espacios ni metacaracteres).
  return /^[\w./-]+$/.test(r) ? r : null;
}

// Valida y normaliza la URL del repo. Devuelve null si no es aceptable.
function parseRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") return null;
  let u;
  try {
    u = new URL(repoUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;

  const parts = u.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[parts.length - 1];
  return {
    owner,
    repo,
    cleanUrl: `https://${u.hostname}/${parts.join("/")}`,
    slug: parts.join("/"),
  };
}

/**
 * Clona el repo indicado y recopila su codigo fuente.
 *
 * Nunca lanza: ante cualquier fallo (URL no permitida, sin auth, offline...)
 * devuelve { ok:false, reason } para que el RCA continue sin contexto de codigo.
 *
 * @param {string} repoUrl  URL del repo (vcs.repository.url.full).
 * @param {object} [opts]
 * @param {string} [opts.ref]  commit o rama (vcs.ref.head.revision).
 * @returns {Promise<object>} { ok, repo, ref, head, dir, files, snippet } | { ok:false, reason }
 */
export async function fetchRepoContext(repoUrl, opts = {}) {
  const info = parseRepoUrl(repoUrl);
  if (!info) {
    return { ok: false, reason: `URL de repo ausente, invalida o no permitida: ${repoUrl ?? "(vacia)"}` };
  }

  const ref = sanitizeRef(opts.ref);
  const dest = path.join(WORKDIR, `${info.owner}-${info.repo}`);

  try {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(WORKDIR, { recursive: true });

    // Clon superficial (rapido; no necesitamos historia).
    const cloneArgs = ["clone", "--depth", "1"];
    if (ref && !isSha(ref)) cloneArgs.push("--branch", ref);
    cloneArgs.push("--", `${info.cleanUrl}.git`, dest);
    await execFileP("git", cloneArgs, { timeout: CLONE_TIMEOUT_MS, windowsHide: true });

    // Si el ref es un commit concreto, intentamos posicionarnos en el.
    // Si falla (p.ej. el server no permite fetch por SHA) seguimos con HEAD.
    if (ref && isSha(ref)) {
      try {
        await execFileP("git", ["-C", dest, "fetch", "--depth", "1", "origin", ref], { timeout: CLONE_TIMEOUT_MS, windowsHide: true });
        await execFileP("git", ["-C", dest, "checkout", "--detach", ref], { timeout: 30000, windowsHide: true });
      } catch {
        /* nos quedamos en el HEAD por defecto */
      }
    }
  } catch (err) {
    return { ok: false, reason: `git clone fallo: ${err.message}` };
  }

  let head = null;
  try {
    const { stdout } = await execFileP("git", ["-C", dest, "rev-parse", "HEAD"], { timeout: 10000, windowsHide: true });
    head = stdout.trim();
  } catch {
    /* opcional */
  }

  const { snippet, files } = await collectSource(dest);
  return { ok: true, repo: info.cleanUrl, ref, head, dir: dest, files, snippet };
}

// Recorre el arbol clonado y construye un unico bloque de texto con el codigo,
// priorizando fuentes sobre config y respetando un presupuesto de caracteres.
async function collectSource(root) {
  const collected = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const eligible = SOURCE_EXT.has(ext) || SPECIAL_FILES.has(e.name);
        if (!eligible) continue;
        collected.push({
          abs: path.join(dir, e.name),
          rel: path.relative(root, path.join(dir, e.name)).replace(/\\/g, "/"),
          priority: SOURCE_EXT.has(ext) ? 0 : 1, // fuentes antes que config
        });
      }
    }
  }
  await walk(root);

  // fuentes primero, luego orden alfabetico estable.
  collected.sort((a, b) => a.priority - b.priority || a.rel.localeCompare(b.rel));

  const files = [];
  const blocks = [];
  let total = 0;
  for (const f of collected) {
    if (total >= MAX_TOTAL_CHARS) break;
    let content;
    try {
      content = await fs.readFile(f.abs, "utf8");
    } catch {
      continue;
    }
    let truncated = false;
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS);
      truncated = true;
    }
    if (total + content.length > MAX_TOTAL_CHARS) {
      content = content.slice(0, MAX_TOTAL_CHARS - total);
      truncated = true;
    }
    total += content.length;
    files.push({ path: f.rel, bytes: content.length, truncated });
    blocks.push(
      `\n===== ${f.rel}${truncated ? "  (RECORTADO)" : ""} =====\n${content}`,
    );
  }

  return { snippet: blocks.join("\n"), files };
}

export const repoConfig = { WORKDIR, ALLOWED_HOSTS };
