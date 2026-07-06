// Caso de uso: LLEVAR A CABO la implementación del fix propuesto por el RCA.
//
// A partir de un informe (con contexto de código: repo + commit del incidente),
// clona el repo, le pide al LLM el archivo corregido, lo aplica y —si hay
// credencial de escritura— abre un Pull Request para revisión humana.
//
// GUARDARRAÍLES:
//   - Nunca se hace merge: solo se abre el PR (revisión humana obligatoria).
//   - Modo seguro por defecto: SIN GITHUB_TOKEN se ejecuta en "dry-run" (genera
//     el parche y devuelve el diff propuesto, pero NO hace push ni abre PR).
//   - Solo repos de la allowlist (github.com por defecto); el archivo propuesto
//     por el LLM se valida dentro del repo; el token nunca se registra.
//
// Configuración:
//   GITHUB_TOKEN / GH_TOKEN   token con permiso de PR sobre el repo objetivo.
//   IMPLEMENT_DRY_RUN=1        fuerza dry-run aunque haya token.
//
// Contrato (estable):
//   implementFix({ id, report }) -> Promise<{
//     status: "pr_opened" | "dry_run" | "skipped" | "failed",
//     message: string,
//     fix: object | null,
//   }>
// Nunca lanza: cualquier problema se devuelve como { status: "failed", ... }.

import {
  parseGitHubRepo,
  cloneDefaultBranch,
  proposeFix,
  applyFix,
  openPullRequest,
} from "./fix.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const FORCE_DRY_RUN = /^(1|true|yes|on)$/i.test(process.env.IMPLEMENT_DRY_RUN || "");
const DRY_RUN = FORCE_DRY_RUN || !GITHUB_TOKEN;

const MAX_DIFF_CHARS = 8000; // recorte del diff que devolvemos al dashboard

export async function implementFix({ id, report }) {
  // --- Precondiciones -------------------------------------------------------
  const cc = report?.code_context;
  if (!cc || cc.available === false || !cc.repo) {
    return skipped(
      "El informe no tiene contexto de código (repo/commit); no se puede generar un fix. " +
        "Reproduce el incidente con un servicio instrumentado que publique vcs.repository.url.full.",
    );
  }

  const info = parseGitHubRepo(cc.repo);
  if (!info) {
    return skipped(`Repo no soportado o fuera de la allowlist: ${cc.repo}`);
  }

  const files = Array.isArray(cc.files) ? cc.files.filter((f) => f && f.path) : [];
  if (files.length === 0) {
    return skipped("El informe no lista archivos de código sobre los que trabajar.");
  }

  // --- Generación del fix ---------------------------------------------------
  try {
    const { dir, baseBranch } = await cloneDefaultBranch({
      owner: info.owner,
      repo: info.repo,
      host: info.host,
      token: GITHUB_TOKEN, // vacío en dry-run público: clon anónimo
    });

    const proposal = await proposeFix({ report, dir, files });
    const { changed, diff } = await applyFix({
      dir,
      file: proposal.file,
      new_content: proposal.new_content,
    });

    if (!changed) {
      return {
        status: "failed",
        message: `El fix propuesto para ${proposal.file} no introduce cambios; no se abre PR.`,
        fix: { file: proposal.file, explanation: proposal.explanation },
      };
    }

    const clippedDiff =
      diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n… (diff recortado)" : diff;

    // --- Dry-run: no tocamos el remoto -------------------------------------
    if (DRY_RUN) {
      return {
        status: "dry_run",
        message: FORCE_DRY_RUN
          ? `Fix generado para ${proposal.file} (dry-run forzado). Revisa el diff; define GITHUB_TOKEN y desactiva IMPLEMENT_DRY_RUN para abrir el PR.`
          : `Fix generado para ${proposal.file}. Falta GITHUB_TOKEN para abrir el PR: se muestra el diff propuesto (no se hizo push).`,
        fix: {
          file: proposal.file,
          base_branch: baseBranch,
          pr_title: proposal.pr_title,
          explanation: proposal.explanation,
          diff: clippedDiff,
        },
      };
    }

    // --- Apertura del PR ----------------------------------------------------
    const pr = await openPullRequest({
      owner: info.owner,
      repo: info.repo,
      host: info.host,
      token: GITHUB_TOKEN,
      dir,
      baseBranch,
      file: proposal.file,
      pr_title: proposal.pr_title,
      pr_body: proposal.pr_body,
      explanation: proposal.explanation,
    });

    return {
      status: "pr_opened",
      message: `PR abierto: ${pr.pr_url} (rama ${pr.branch} → ${baseBranch}). Requiere revisión humana; no se auto-mergea.`,
      fix: {
        file: proposal.file,
        base_branch: baseBranch,
        branch: pr.branch,
        pr_url: pr.pr_url,
        pr_number: pr.pr_number,
        explanation: proposal.explanation,
      },
    };
  } catch (err) {
    return {
      status: "failed",
      message: `No se pudo implementar el fix: ${err.message}`,
      fix: null,
    };
  }
}

function skipped(message) {
  return { status: "skipped", message, fix: null };
}
