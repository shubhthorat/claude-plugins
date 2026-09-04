import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ─────────────────────────────────────────────────────────────────────
// VAST_API_SERVER_URL  — base URL of your Brainrot server (e.g. https://server.shubhthorat.com)
// VAST_API_KEY         — your Brainrot server API key (same as used for ssh-cluster)
// VAST_SSH_KEY_PATH    — path to SSH private key registered in Vast.ai (default: ~/.ssh/id_rsa)
// VAST_SSH_USER        — SSH username on Vast.ai instances (default: root)

const CONFIG_DIR = join(homedir(), ".config", "vast-ai");
const CONFIG_FILE = join(CONFIG_DIR, "env.json");

function loadPersistentConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

const persistentConfig = loadPersistentConfig();

function getEnv(name) {
  return (process.env[name] || persistentConfig[name] || "").trim();
}

function getApiServerUrl() {
  const raw = getEnv("VAST_API_SERVER_URL") || getEnv("API_SERVER_URL") || getEnv("API_SERVER_HOST");
  if (!raw) return "";
  let s = raw.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

function getApiKey() {
  return getEnv("VAST_API_KEY") || getEnv("API_SERVER_KEY") || getEnv("API_KEY");
}

function getSshKeyPath() {
  return getEnv("VAST_SSH_KEY_PATH") || join(homedir(), ".ssh", "id_rsa");
}

function getSshUser() {
  return getEnv("VAST_SSH_USER") || "root";
}

// ── Server API helpers ─────────────────────────────────────────────────────────

async function serverRequest(method, path, body) {
  const base = getApiServerUrl();
  if (!base) throw new Error("VAST_API_SERVER_URL not configured. Set it in MCP env or ~/.config/vast-ai/env.json");
  const key = getApiKey();
  if (!key) throw new Error("VAST_API_KEY not configured.");

  const url = `${base}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": key },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Server error ${res.status}: ${data.error || text}`);
  return data;
}

// ── SSH execution ──────────────────────────────────────────────────────────────

function sshExec(host, port, command, timeoutMs = 120000) {
  const keyPath = getSshKeyPath();
  const user = getSshUser();
  const sshCmd = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=15",
    "-o", "BatchMode=yes",
    "-i", keyPath,
    "-p", String(port),
    `${user}@${host}`,
    command,
  ];
  const result = execSync(sshCmd.join(" "), {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return result;
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "vast-ai", version: "0.1.0" });

server.tool(
  "vast_list_instances",
  "List all running Vast.ai instances with SSH connection info.",
  {},
  async () => {
    const data = await serverRequest("GET", "/vast/instances");
    const lines = (data.instances || []).map((i) =>
      `[${i.id}] ${i.gpu} ${i.vram_gb}GB  $${i.price_hr}/hr  status=${i.status}  ssh_cmd="${i.ssh_cmd || "not ready"}"`
    );
    return {
      content: [{
        type: "text",
        text: lines.length ? lines.join("\n") : "No running instances.",
      }],
    };
  }
);

server.tool(
  "vast_run_command",
  "SSH into a Vast.ai instance and run a shell command. Returns stdout.",
  {
    instance_id: z.number().describe("Instance ID from vast_list_instances"),
    command: z.string().describe("Shell command to run on the instance"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
  },
  async ({ instance_id, command, timeout_ms }) => {
    const data = await serverRequest("GET", `/vast/instance/${instance_id}`);
    const host = data.ssh_host;
    const port = data.ssh_port || 22;
    if (!host) throw new Error(`Instance ${instance_id} has no SSH host yet — may still be starting up`);

    // Wrap command to activate venv if present
    const wrapped = `bash -c 'source /venv/main/bin/activate 2>/dev/null; ${command.replace(/'/g, "'\\''")}'`;
    const output = sshExec(host, port, wrapped, timeout_ms || 120000);
    return { content: [{ type: "text", text: output || "(no output)" }] };
  }
);

server.tool(
  "vast_run_script",
  "SSH into a Vast.ai instance and run a multi-line bash script.",
  {
    instance_id: z.number().describe("Instance ID from vast_list_instances"),
    script: z.string().describe("Multi-line bash script to run"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default 300000)"),
  },
  async ({ instance_id, script, timeout_ms }) => {
    const data = await serverRequest("GET", `/vast/instance/${instance_id}`);
    const host = data.ssh_host;
    const port = data.ssh_port || 22;
    if (!host) throw new Error(`Instance ${instance_id} has no SSH host yet`);

    const keyPath = getSshKeyPath();
    const user = getSshUser();
    const fullScript = `source /venv/main/bin/activate 2>/dev/null\n${script}`;
    const encoded = Buffer.from(fullScript).toString("base64");
    const cmd = `echo ${encoded} | base64 -d | bash`;
    const sshCmd = [
      "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15",
      "-o", "BatchMode=yes", "-i", keyPath, "-p", String(port),
      `${user}@${host}`, cmd,
    ].join(" ");
    const output = execSync(sshCmd, {
      timeout: timeout_ms || 300000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { content: [{ type: "text", text: output || "(no output)" }] };
  }
);

server.tool(
  "vast_search_offers",
  "Search available Vast.ai GPU offers. Returns best options sorted by price.",
  {
    min_vram_gb: z.number().optional().describe("Minimum VRAM in GB (default 24)"),
    min_disk_gb: z.number().optional().describe("Minimum disk in GB (default 150)"),
    verified: z.boolean().optional().describe("Verified hosts only (default true)"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ min_vram_gb = 24, min_disk_gb = 150, verified = true, limit = 10 }) => {
    const qs = `min_vram_gb=${min_vram_gb}&min_disk_gb=${min_disk_gb}&verified=${verified}&limit=${limit}`;
    const data = await serverRequest("GET", `/vast/offers?${qs}`);
    const lines = (data.offers || []).map((o) =>
      `[${o.id}] ${o.gpu} ${o.vram_gb}GB  $${o.price_hr}/hr  disk=${o.disk_gb}GB  cuda=${o.cuda}  reliability=${o.reliability?.toFixed(3)}  ${o.country || ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") || "No offers found." }] };
  }
);

server.tool(
  "vast_create_instance",
  "Create a new Vast.ai GPU instance from an offer.",
  {
    offer_id: z.number().describe("Offer ID from vast_search_offers"),
    image: z.string().optional().describe("Docker image (default: vastai/pytorch:latest)"),
    disk_gb: z.number().optional().describe("Disk size in GB (default 150)"),
  },
  async ({ offer_id, image = "vastai/pytorch:latest", disk_gb = 150 }) => {
    const data = await serverRequest("POST", "/vast/instance", { offer_id, image, disk_gb });
    return {
      content: [{
        type: "text",
        text: `Instance created: id=${data.instance_id}\nUse vast_list_instances to get SSH info once it's running (usually 30-60s).`,
      }],
    };
  }
);

server.tool(
  "vast_destroy_instance",
  "Destroy (permanently delete) a Vast.ai instance.",
  {
    instance_id: z.number().describe("Instance ID to destroy"),
  },
  async ({ instance_id }) => {
    const data = await serverRequest("DELETE", `/vast/instance/${instance_id}`);
    return { content: [{ type: "text", text: data.message || `Instance ${instance_id} destroyed.` }] };
  }
);

server.tool(
  "vast_save_config",
  "Save Vast.ai plugin configuration persistently to ~/.config/vast-ai/env.json.",
  {
    api_server_url: z.string().optional().describe("Brainrot server URL"),
    api_key: z.string().optional().describe("Brainrot server API key"),
    ssh_key_path: z.string().optional().describe("Path to SSH private key"),
  },
  async ({ api_server_url, api_key, ssh_key_path }) => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = loadPersistentConfig();
    const updated = { ...existing };
    if (api_server_url) updated.VAST_API_SERVER_URL = api_server_url;
    if (api_key) updated.VAST_API_KEY = api_key;
    if (ssh_key_path) updated.VAST_SSH_KEY_PATH = ssh_key_path;
    writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
    return { content: [{ type: "text", text: `Config saved to ${CONFIG_FILE}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
