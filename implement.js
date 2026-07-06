// Caso de uso: LLEVAR A CABO la implementación del fix propuesto por el RCA.
//
// ⚠️ SCAFFOLD / PENDIENTE. Hoy este caso de uso todavía NO implementa el fix.
// Existe para que el botón "Implementar fix" del dashboard sea funcional de punta
// a punta (UI -> POST /api/reports/:id/implement -> este caso de uso) y para dejar
// registrada la DECISIÓN del usuario de implementar. La ejecución real (generar el
// parche desde el RCA y abrir un Pull Request, sin auto-merge) se añadirá en una
// próxima iteración. Roadmap: rca-lab/docs/ESTADO.md § "Próximos pasos".
//
// Contrato (estable, para que la lógica real sea un drop-in):
//   implementFix({ id, report }) -> Promise<{
//     status: "pending" | "pr_opened" | "failed" | "skipped",
//     message: string,          // texto legible para el dashboard
//     fix: object | null,       // detalle del fix cuando exista (branch, pr_url, diff...)
//   }>
//
// Nunca debe lanzar: cualquier problema se devuelve como { status: "failed", ... }
// para que el endpoint responda de forma controlada.

export async function implementFix({ id, report }) {
  // TODO (próxima iteración) — aquí irá la ejecución real:
  //   1. Localizar repo y commit del incidente (report.triage / payload / vcs.*).
  //   2. Derivar el parche a partir de probable_causes + action_plan (LLM acotado
  //      al fichero/función que el RCA ya señala).
  //   3. Crear rama, commit y abrir un Pull Request (credencial de escritura
  //      separada de la deploy key de solo lectura de GitOps; nunca auto-merge).
  //   4. Opcional: correr los tests del repo objetivo sobre el parche.
  //   5. return { status: "pr_opened", message, fix: { branch, pr_url, diff_stat } }.
  void report; // aún no se usa; evita el warning de parámetro sin utilizar

  return {
    status: "pending",
    message:
      "Decisión registrada: implementar el fix. La ejecución automática " +
      "(generar el parche y abrir el PR) todavía no está disponible; se hará " +
      "en una próxima iteración.",
    fix: null,
  };
}
