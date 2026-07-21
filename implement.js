// Caso de uso: LLEVAR A CABO la implementación del fix propuesto por el RCA.
//
// A partir de un informe (con contexto de código: repo + commit del incidente),
// clona el repo y construye el fix en una RAMA con DOS COMMITS ATÓMICOS que
// siguen Conventional Commits:
//   1) `test:` un test de regresión que reproduce el bug (estado ROJO).
//   2) `fix:`  el cambio de código productivo que lo corrige (estado VERDE).
// Si hay credencial de escritura, abre un Pull Request para revisión humana.
//
// VERIFICACIÓN antes/después: si detecta un runner de tests disponible en el
// entorno (npm/pytest), ejecuta la suite para comprobar que el test FALLA sin el
// fix y PASA con él. Si el runtime no está disponible, cae a "modo documentado"
// (construye los commits igualmente y lo deja constar en el PR, para el CI).
//
// GUARDARRAÍLES:
//   - Nunca se hace merge: solo se abre el PR (revisión humana obligatoria).
//   - Modo seguro por defecto: SIN GITHUB_TOKEN se ejecuta en "dry-run" (genera
//     los commits en el clon local y devuelve el diff, pero NO hace push ni PR).
//   - Solo repos de la allowlist (github.com por defecto); el archivo propuesto
//     por el LLM se valida dentro del repo; el token nunca se registra.
//
// Configuración:
//   GITHUB_TOKEN / GH_TOKEN   token con permiso de PR sobre el repo objetivo.
//   IMPLEMENT_DRY_RUN=1        fuerza dry-run aunque haya token.
//   FIX_TEST_RUN=off           desactiva la ejecución de tests (solo documentado).
//   FIX_TEST_TIMEOUT_MS        timeout de la ejecución de la suite (def. 120000).
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
  proposeRegressionTest,
  applyRegressionTest,
  detectTestRunner,
  runTests,
  createFixBranch,
  commitPaths,
  diffSince,
  pushAndOpenPr,
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

  // --- Construcción del fix (test → fix) ------------------------------------
  try {
    const { dir, baseBranch, baseSha } = await cloneDefaultBranch({
      owner: info.owner,
      repo: info.repo,
      host: info.host,
      token: GITHUB_TOKEN, // vacío en dry-run público: clon anónimo
    });

    // 1) Proponemos el fix y el test (ambos ANTES de tocar nada).
    const proposal = await proposeFix({ report, dir, files });
    const testProposal = await proposeRegressionTest({
      report, dir, files, fixFile: proposal.file,
    });
    const runner = await detectTestRunner({ dir, files });

    // 2) Rama del fix.
    const branch = await createFixBranch({ dir, token: GITHUB_TOKEN });

    // 3) Aplicamos el TEST y comprobamos el estado "antes" (esperado: ROJO).
    const testApplied = await applyRegressionTest({ dir, proposal: testProposal });
    if (!testApplied.changed) {
      return failed(`El test propuesto (${testProposal.test_file}) no introduce cambios.`, null);
    }
    const before = await runTests({ dir, runner });
    if (before.ran && before.status === "pass") {
      // El test pasa SIN el fix: no reproduce el bug -> no respalda el cambio.
      return failed(
        `El test de regresión propuesto pasa sin el fix: no reproduce el bug, así que no respalda el cambio. No se abre PR.`,
        { file: proposal.file, test_file: testProposal.test_file },
      );
    }

    // Commit atómico #1: el test (estado rojo).
    await commitPaths({
      dir,
      paths: [testProposal.test_file],
      subject: testProposal.commit_subject,
      body: testProposal.commit_body,
      token: GITHUB_TOKEN,
    });

    // 4) Aplicamos el FIX productivo y comprobamos el estado "después" (VERDE).
    const fixApplied = await applyFix({
      dir, file: proposal.file, new_content: proposal.new_content,
    });
    if (!fixApplied.changed) {
      return failed(`El fix propuesto para ${proposal.file} no introduce cambios; no se abre PR.`, {
        file: proposal.file,
        explanation: proposal.explanation,
      });
    }
    const after = await runTests({ dir, runner });
    if (after.ran && after.status === "fail") {
      return failed(
        `El fix aplicado no hace pasar el test de regresión (${testProposal.test_file}); no se abre PR.`,
        { file: proposal.file, test_file: testProposal.test_file, explanation: proposal.explanation },
      );
    }

    // Commit atómico #2: el fix productivo (estado verde).
    await commitPaths({
      dir,
      paths: [proposal.file],
      subject: proposal.pr_title,
      body: proposal.explanation || "fix automatico",
      token: GITHUB_TOKEN,
    });

    // 5) Resumen de verificación y diff acumulado (test + fix).
    const verification = buildVerification({ runner, before, after });
    const fullDiff = await diffSince({ dir, fromRef: baseSha, token: GITHUB_TOKEN });
    const clippedDiff =
      fullDiff.length > MAX_DIFF_CHARS ? fullDiff.slice(0, MAX_DIFF_CHARS) + "\n… (diff recortado)" : fullDiff;

    const commonFix = {
      file: proposal.file,
      test_file: testProposal.test_file,
      base_branch: baseBranch,
      branch,
      pr_title: proposal.pr_title,
      explanation: proposal.explanation,
      verification,
      commits: [testProposal.commit_subject, proposal.pr_title],
    };

    // --- Dry-run: no tocamos el remoto -------------------------------------
    if (DRY_RUN) {
      return {
        status: "dry_run",
        message:
          `Fix construido en 2 commits atómicos (test → fix) sobre la rama ${branch}. ` +
          verificationSummary(verification) + " " +
          (FORCE_DRY_RUN
            ? "Dry-run forzado: revisa el diff; define GITHUB_TOKEN y desactiva IMPLEMENT_DRY_RUN para abrir el PR."
            : "Falta GITHUB_TOKEN para abrir el PR: se muestra el diff (no se hizo push)."),
        fix: { ...commonFix, diff: clippedDiff },
      };
    }

    // --- Apertura del PR ----------------------------------------------------
    const pr = await pushAndOpenPr({
      owner: info.owner,
      repo: info.repo,
      host: info.host,
      token: GITHUB_TOKEN,
      dir,
      branch,
      baseBranch,
      pr_title: proposal.pr_title,
      pr_body: buildPrBody({ proposal, testProposal, verification }),
    });

    return {
      status: "pr_opened",
      message:
        `PR abierto: ${pr.pr_url} (rama ${branch} → ${baseBranch}, 2 commits atómicos test→fix). ` +
        verificationSummary(verification) + " Requiere revisión humana; no se auto-mergea.",
      fix: { ...commonFix, pr_url: pr.pr_url, pr_number: pr.pr_number, diff: clippedDiff },
    };
  } catch (err) {
    return failed(`No se pudo implementar el fix: ${err.message}`, null);
  }
}

// --- Verificación antes/después ---------------------------------------------

// Interpreta las ejecuciones "antes" (con test, sin fix) y "después" (con ambos).
// mode: "executed" si se corrió la suite y probó rojo→verde; "documented" si no
// se pudo ejecutar (sin runner, deps ausentes, timeout…): los commits se crean
// igualmente y la comprobación queda para el CI/revisor.
function buildVerification({ runner, before, after }) {
  const executed =
    before.ran && after.ran &&
    before.status !== "inconclusive" && after.status !== "inconclusive";

  if (executed) {
    return {
      mode: "executed",
      runner: runner.label || null,
      before: before.status, // "fail" esperado
      after: after.status,   // "pass" esperado
      verified: before.status === "fail" && after.status === "pass",
      note: "",
    };
  }
  return {
    mode: "documented",
    runner: runner.label || null,
    before: before.ran ? before.status : null,
    after: after.ran ? after.status : null,
    verified: false,
    note: runner.reason || before.reason || after.reason || "no se pudo ejecutar la suite en el entorno del agente",
  };
}

function verificationSummary(v) {
  if (v.mode === "executed") {
    return v.verified
      ? `Verificado con ${v.runner}: el test falla sin el fix y pasa con él.`
      : `Ejecución con ${v.runner} no concluyente (antes=${v.before}, después=${v.after}); revísalo.`;
  }
  return `Verificación diferida (modo documentado: ${v.note}); confirma en CI el rojo→verde.`;
}

function buildPrBody({ proposal, testProposal, verification }) {
  const lines = [];
  if (proposal.pr_body) lines.push(proposal.pr_body, "");
  if (proposal.explanation) lines.push(`**Cambio productivo:** ${proposal.explanation}`, "");
  lines.push(
    `**Test de regresión:** \`${testProposal.test_file}\` — ${testProposal.commit_body || testProposal.commit_subject}`,
    "",
    `**Verificación:** ${verificationSummary(verification)}`,
    "",
    "**Commits (atómicos, Conventional Commits):**",
    `1. \`${testProposal.commit_subject}\``,
    `2. \`${proposal.pr_title}\``,
    "",
    "_PR generado automáticamente por ai-sre-agent a partir de un informe RCA. " +
      "Requiere revisión humana; no se auto-mergea._",
  );
  return lines.join("\n");
}

// --- helpers de resultado ---------------------------------------------------

function skipped(message) {
  return { status: "skipped", message, fix: null };
}

function failed(message, fix) {
  return { status: "failed", message, fix: fix ?? null };
}
