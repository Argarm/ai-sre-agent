// Cliente minimo para el servidor local de Ollama.
// No requiere dependencias: usa fetch nativo de Node (>=18).

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";
// Ventana de contexto. El default de Ollama (4096) trunca el prompt de hipotesis
// (codigo del repo + stacktrace) y degrada la salida. 16384 cubre el peor caso
// (cap de ~40KB de codigo en repo.js) y mantiene qwen3:8b 100% en GPU (~7.3 GB).
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 16384);

// Normaliza el host: acepta valores tipo "0.0.0.0:11434" o "localhost:11434"
// (formato que exporta el propio Ollama) y les anade esquema/host conectable.
function normalizeHost(value) {
  let host = (value || "").trim() || "http://localhost:11434";
  if (!/^https?:\/\//i.test(host)) host = "http://" + host;
  // 0.0.0.0 es una direccion de escucha, no de conexion -> usar loopback.
  return host.replace("://0.0.0.0", "://localhost");
}

const OLLAMA_HOST = normalizeHost(process.env.OLLAMA_HOST);

/**
 * Llama al endpoint /api/chat de Ollama en modo no-streaming.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @param {boolean} [opts.json]  Pide salida en formato JSON.
 * @param {number}  [opts.temperature]
 * @returns {Promise<string>} contenido del mensaje del asistente.
 */
export async function chat(messages, opts = {}) {
  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    // qwen3 es un modelo "thinking". Desactivamos el razonamiento visible
    // para que la respuesta sea directa y rapida.
    think: false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_ctx: OLLAMA_NUM_CTX,
    },
  };

  if (opts.json) body.format = "json";

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama respondio ${res.status}: ${text}`);
  }

  const data = await res.json();
  return stripThinkTags(data.message?.content ?? "");
}

/**
 * Igual que chat() pero parsea la respuesta como JSON de forma tolerante.
 */
export async function chatJson(messages, opts = {}) {
  const raw = await chat(messages, { ...opts, json: true });
  return safeParseJson(raw);
}

// Algunos modelos ignoran think:false y devuelven <think>...</think>.
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Extrae el primer bloque JSON valido aunque venga rodeado de texto.
function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* cae al fallback */
      }
    }
    return { _raw: text, _parseError: true };
  }
}

export const config = { OLLAMA_HOST, OLLAMA_MODEL };
