// Envia un payload de error de ejemplo al webhook.
//   node scripts/send-test.js
//   node scripts/send-test.js http://localhost:3000/webhook

const url = process.argv[2] || "http://localhost:3000/webhook";

const samplePayload = {
  service: "checkout-api",
  environment: "production",
  timestamp: new Date().toISOString(),
  level: "error",
  message: "Timeout waiting for response from payments-db",
  error: {
    type: "SequelizeConnectionAcquireTimeoutError",
    stack:
      "SequelizeConnectionAcquireTimeoutError: Operation timeout\n" +
      "  at ConnectionManager._acquire (/app/node_modules/sequelize/lib/pool.js:120)\n" +
      "  at process.processTicksAndRejections (node:internal/process/task_queues)",
  },
  context: {
    host: "checkout-api-7d9f-abc",
    db_pool: { size: 10, in_use: 10, waiting: 34 },
    recent_deploy: "hace 12 min (commit a1b2c3d)",
    p99_latency_ms: 8400,
  },
};

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(process.env.WEBHOOK_TOKEN
      ? { "X-Webhook-Token": process.env.WEBHOOK_TOKEN }
      : {}),
  },
  body: JSON.stringify(samplePayload),
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());
