#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const APP_BIN =
  process.env.CODEX_APP_BIN || "/Applications/Codex.app/Contents/MacOS/Codex";
const DEBUG_PORT = Number.parseInt(
  process.env.CODEX_REMOTE_DEBUG_PORT || "9222",
  10,
);
const THREAD_LIMIT = Number.parseInt(
  process.env.CODEX_THREAD_LIST_LIMIT || "5000",
  10,
);
const START_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_START_TIMEOUT_MS || "30000",
  10,
);
const CDP_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_CDP_COMMAND_TIMEOUT_MS || "10000",
  10,
);
const PROXY = process.env.CODEX_PROXY || "http://127.0.0.1:7890";
const NO_PROXY_LIST = process.env.CODEX_NO_PROXY || "127.0.0.1,localhost";
const BACKGROUND = process.env.CODEX_BACKGROUND === "1";

if (!Number.isFinite(DEBUG_PORT) || DEBUG_PORT <= 0) {
  throw new Error(`Invalid CODEX_REMOTE_DEBUG_PORT: ${DEBUG_PORT}`);
}

if (!Number.isFinite(THREAD_LIMIT) || THREAD_LIMIT < 200) {
  throw new Error(
    `Invalid CODEX_THREAD_LIST_LIMIT: ${THREAD_LIMIT} (expected >= 200)`,
  );
}

if (!Number.isFinite(CDP_COMMAND_TIMEOUT_MS) || CDP_COMMAND_TIMEOUT_MS <= 0) {
  throw new Error(
    `Invalid CODEX_CDP_COMMAND_TIMEOUT_MS: ${CDP_COMMAND_TIMEOUT_MS}`,
  );
}

function log(level, message, details = null) {
  const suffix =
    details == null ? "" : ` ${JSON.stringify(details, null, 0)}`;
  console.error(
    `[codex-launch ${new Date().toISOString()}] ${level} ${message}${suffix}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAppAsarPath() {
  return (
    process.env.CODEX_APP_ASAR ||
    path.resolve(path.dirname(APP_BIN), "../Resources/app.asar")
  );
}

function readAppAsar() {
  const asarPath = getAppAsarPath();
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(12);
  const pickleSize = buffer.readUInt32LE(4);
  const header = JSON.parse(
    buffer.subarray(16, 16 + headerSize).toString("utf8"),
  );
  return {
    asarPath,
    buffer,
    contentStart: 8 + pickleSize,
    header,
  };
}

function walkAsarFiles(node, visit, prefix = "") {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walkAsarFiles(child, visit, prefix ? `${prefix}/${name}` : name);
    }
    return;
  }

  visit(prefix, node);
}

function readAsarText(asar, filePath, node) {
  return asar.buffer
    .subarray(
      asar.contentStart + Number(node.offset),
      asar.contentStart + Number(node.offset) + node.size,
    )
    .toString("utf8");
}

function getPatchCompatibilityInfo() {
  const asar = readAppAsar();
  const appServerManagerAssets = [];
  let checkedAssetCount = 0;
  let hasMcpRequest = false;
  let hasSendMessageFromView = false;
  let hasThreadList = false;
  let vscodeApiAssetPath = null;

  walkAsarFiles(asar.header, (filePath, node) => {
    if (!/^webview\/assets\/.*\.js$/.test(filePath)) {
      return;
    }

    checkedAssetCount += 1;
    if (/^webview\/assets\/vscode-api-.*\.js$/.test(filePath)) {
      vscodeApiAssetPath = filePath;
    }
    if (/^webview\/assets\/app-server-manager-.*\.js$/.test(filePath)) {
      appServerManagerAssets.push(filePath);
    }

    const text = readAsarText(asar, filePath, node);
    hasMcpRequest ||= text.includes("mcp-request");
    hasSendMessageFromView ||= text.includes("sendMessageFromView");
    hasThreadList ||= text.includes("thread/list");
  });

  const missing = [];
  if (!vscodeApiAssetPath) {
    missing.push("vscode-api asset");
  }
  if (!hasMcpRequest) {
    missing.push("mcp-request dispatch path");
  }
  if (!hasSendMessageFromView) {
    missing.push("sendMessageFromView bridge path");
  }
  if (!hasThreadList) {
    missing.push("thread/list request path");
  }
  if (appServerManagerAssets.length === 0) {
    missing.push("app-server-manager asset");
  }

  if (missing.length > 0) {
    throw new Error(
      `Codex app bundle no longer exposes expected patch surface: ${missing.join(", ")}`,
    );
  }

  return {
    asarPath: asar.asarPath,
    checkedAssetCount,
    appServerManagerAssets,
    vscodeApiUrl: `app://-/${vscodeApiAssetPath.replace(/^webview\//, "")}`,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function launchCodex() {
  const childEnv = { ...process.env };

  if (PROXY.trim().length > 0) {
    childEnv.HTTP_PROXY = PROXY;
    childEnv.HTTPS_PROXY = PROXY;
    childEnv.http_proxy = PROXY;
    childEnv.https_proxy = PROXY;
  }

  if (NO_PROXY_LIST.trim().length > 0) {
    childEnv.NO_PROXY = NO_PROXY_LIST;
    childEnv.no_proxy = NO_PROXY_LIST;
  }

  log("INFO", "launching Codex", {
    appBin: APP_BIN,
    debugPort: DEBUG_PORT,
    proxy: PROXY || null,
    noProxy: NO_PROXY_LIST || null,
    threadLimit: THREAD_LIMIT,
    mode: BACKGROUND ? "background" : "foreground",
  });

  const child = spawn(
    APP_BIN,
    [`--remote-debugging-port=${DEBUG_PORT}`],
    {
      detached: BACKGROUND,
      env: childEnv,
      stdio: BACKGROUND ? "ignore" : "inherit",
    },
  );

  child.once("error", (error) => {
    log("ERROR", "failed to spawn Codex", {
      appBin: APP_BIN,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  log("INFO", "Codex process spawned", {
    pid: child.pid ?? null,
  });

  if (BACKGROUND) {
    child.unref();
  }
  return child;
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateLaunchedCodex(child, reason) {
  const pid = child?.pid ?? null;
  if (!Number.isFinite(pid) || pid <= 0) {
    log("WARN", "no spawned Codex pid available for cleanup", { reason });
    return;
  }

  log("ERROR", "terminating launched Codex because startup patch failed", {
    pid,
    reason,
  });

  try {
    process.kill(-pid, "SIGTERM");
  } catch (groupError) {
    log("WARN", "failed to SIGTERM process group, trying main pid", {
      pid,
      error:
        groupError instanceof Error ? groupError.message : String(groupError),
    });
    try {
      process.kill(pid, "SIGTERM");
    } catch (pidError) {
      log("WARN", "failed to SIGTERM main pid", {
        pid,
        error: pidError instanceof Error ? pidError.message : String(pidError),
      });
    }
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isProcessAlive(pid)) {
      log("INFO", "launched Codex terminated cleanly", { pid });
      return;
    }
    await sleep(200);
  }

  log("WARN", "Codex still alive after SIGTERM, sending SIGKILL", { pid });

  try {
    process.kill(-pid, "SIGKILL");
  } catch (groupError) {
    log("WARN", "failed to SIGKILL process group, trying main pid", {
      pid,
      error:
        groupError instanceof Error ? groupError.message : String(groupError),
    });
    try {
      process.kill(pid, "SIGKILL");
    } catch (pidError) {
      log("ERROR", "failed to SIGKILL main pid", {
        pid,
        error: pidError instanceof Error ? pidError.message : String(pidError),
      });
      return;
    }
  }

  log("INFO", "SIGKILL sent to launched Codex", { pid });
}

function installTerminationHandlers(child) {
  const onSignal = async (signal) => {
    log("WARN", "received signal while launcher was running", { signal });
    await terminateLaunchedCodex(child, `launcher interrupted by ${signal}`);
    process.exit(1);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

async function waitForTarget() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/list`;

  log("INFO", "waiting for Codex debug target", {
    endpoint,
    timeoutMs: START_TIMEOUT_MS,
  });

  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(endpoint);
      const page =
        targets.find(
          (target) =>
            target.type === "page" &&
            target.title === "Codex" &&
            String(target.url || "").startsWith("app://-/index.html") &&
            typeof target.webSocketDebuggerUrl === "string",
        ) || null;
      if (page) {
        log("INFO", "found Codex debug target", {
          url: page.url,
        });
        return page;
      }
    } catch {
      // Codex may still be starting up. Keep polling.
    }

    await sleep(400);
  }

  throw new Error(
    `Timed out waiting for a debuggable Codex page on port ${DEBUG_PORT}`,
  );
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;

    const cleanup = (error) => {
      for (const { reject: rejectPending, timer } of pending.values()) {
        clearTimeout(timer);
        rejectPending(error);
      }
      pending.clear();
    };

    ws.addEventListener("open", () => {
      resolve({
        async send(method, params = {}) {
          const id = ++nextId;
          const payload = JSON.stringify({ id, method, params });

          return new Promise((resolveSend, rejectSend) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectSend(
                new Error(
                  `Timed out waiting for CDP ${method} response after ${CDP_COMMAND_TIMEOUT_MS}ms`,
                ),
              );
            }, CDP_COMMAND_TIMEOUT_MS);

            pending.set(id, {
              resolve: resolveSend,
              reject: rejectSend,
              timer,
            });

            try {
              ws.send(payload);
            } catch (error) {
              clearTimeout(timer);
              pending.delete(id);
              rejectSend(error);
            }
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest) {
          return;
        }

        pending.delete(message.id);
        clearTimeout(pendingRequest.timer);
        if (message.error) {
          pendingRequest.reject(
            new Error(
              `CDP ${message.error.code}: ${message.error.message || "unknown"}`,
            ),
          );
          return;
        }

        pendingRequest.resolve(message.result);
        return;
      }
    });

    ws.addEventListener("error", (event) => {
      reject(new Error(`WebSocket connection failed: ${String(event.type)}`));
    });

    ws.addEventListener("close", () => {
      cleanup(new Error("CDP connection closed"));
    });
  });
}

function buildRouterDispatchPatchSource(vscodeApiUrl) {
  return `
(() => {
  const limit = ${THREAD_LIMIT};
  const apiUrl = ${JSON.stringify(vscodeApiUrl)};
  const stateKey = "__codexAllThreadsPatchInfo";
  const existing = window[stateKey];
  if (
    existing?.limit === limit &&
    existing?.patchKind === "router-dispatch-rewrite"
  ) {
    return existing;
  }

  const info = {
    limit,
    patchKind: "router-dispatch-rewrite",
    apiUrl,
    installed: false,
    installError: null,
    installAttempts: 0,
    rewriteCount: 0,
    lastRewrite: null,
    routerExportKey: null,
  };
  window[stateKey] = info;

  const rewritePayload = (type, payload) => {
    if (type !== "mcp-request") {
      return payload;
    }

    const request = payload?.request;
    if (request?.method !== "thread/list") {
      return payload;
    }

    const params = request.params;
    if (
      params == null ||
      typeof params !== "object" ||
      params.archived !== false
    ) {
      return payload;
    }

    const currentLimit = Number(params.limit);
    if (
      !Number.isFinite(currentLimit) ||
      currentLimit <= 0 ||
      currentLimit >= limit
    ) {
      return payload;
    }

    const nextPayload = {
      ...payload,
      request: {
        ...request,
        params: {
          ...params,
          limit,
        },
      },
    };
    info.rewriteCount += 1;
    info.lastRewrite = {
      requestId: String(request.id || ""),
      method: request.method,
      from: currentLimit,
      to: limit,
      at: new Date().toISOString(),
    };
    return nextPayload;
  };
  window.__codexAllThreadsRewritePayload = rewritePayload;

  const install = async () => {
    info.installAttempts += 1;
    try {
      const api = await import(apiUrl);
      let router = null;
      let routerExportKey = null;

      for (const [key, value] of Object.entries(api)) {
        if (typeof value?.getInstance !== "function") {
          continue;
        }

        const candidate = value.getInstance();
        if (
          candidate != null &&
          typeof candidate.dispatchMessage === "function" &&
          typeof candidate.subscribe === "function"
        ) {
          router = candidate;
          routerExportKey = key;
          break;
        }
      }

      if (router == null) {
        throw new Error("Codex message router export was not found");
      }

      if (router.dispatchMessage.__codexAllThreadsPatched === limit) {
        info.installed = true;
        info.routerExportKey = routerExportKey;
        return info;
      }

      const original = router.dispatchMessage;
      const wrapped = function codexAllThreadsDispatchMessage(
        type,
        payload,
        ...rest
      ) {
        return original.call(this, type, rewritePayload(type, payload), ...rest);
      };
      Object.defineProperty(wrapped, "__codexAllThreadsPatched", {
        value: limit,
        configurable: true,
      });
      Object.defineProperty(wrapped, "__codexAllThreadsOriginal", {
        value: original,
        configurable: true,
      });
      router.dispatchMessage = wrapped;

      info.installed = true;
      info.installedAt = new Date().toISOString();
      info.routerExportKey = routerExportKey;
      return info;
    } catch (error) {
      info.installError = String(error?.message || error);
      return info;
    }
  };

  window.__codexAllThreadsPatchReady = install();
  return info;
})()
`;
}

async function readRuntimePatchInfo(client) {
  const result = await client.send("Runtime.evaluate", {
    expression:
      "window.__codexAllThreadsPatchReady ? window.__codexAllThreadsPatchReady.then(() => window.__codexAllThreadsPatchInfo ?? null) : (window.__codexAllThreadsPatchInfo ?? null)",
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value || null;
}

async function waitForRewrittenThreadListRequest(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastInfo = null;

  while (Date.now() < deadline) {
    try {
      lastInfo = await readRuntimePatchInfo(client);
      if (
        lastInfo?.limit === THREAD_LIMIT &&
        lastInfo?.patchKind === "router-dispatch-rewrite" &&
        lastInfo?.installed === true &&
        lastInfo?.rewriteCount > 0
      ) {
        return lastInfo;
      }
    } catch {
      // The page may be between execution contexts while reloading.
    }

    await sleep(250);
  }

  throw new Error(
    `Failed to observe rewritten thread/list request after startup reload (lastInfo=${JSON.stringify(
      lastInfo,
    )})`,
  );
}

async function injectPatch(compatibility) {
  const target = await waitForTarget();
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  const patchSource = buildRouterDispatchPatchSource(
    compatibility.vscodeApiUrl,
  );

  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    log("INFO", "installing router dispatch patch", {
      asarPath: compatibility.asarPath,
      vscodeApiUrl: compatibility.vscodeApiUrl,
      appServerManagerAssets: compatibility.appServerManagerAssets,
    });

    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: patchSource,
    });
    const immediateResult = await client.send("Runtime.evaluate", {
      expression: patchSource,
      awaitPromise: true,
      returnByValue: true,
    });
    log("INFO", "installed patch hook on current page", {
      result: immediateResult?.result?.value || null,
    });

    await client.send("Runtime.evaluate", {
      expression: "window.location.reload()",
      awaitPromise: false,
      returnByValue: true,
    });
    log("INFO", "sent Codex page reload to apply startup request patch");

    const value = await waitForRewrittenThreadListRequest(client);
    log("INFO", "observed rewritten recent-conversation request", value);

    return {
      patchedUrl: compatibility.vscodeApiUrl,
      limit: value.limit,
      patchKind: value.patchKind,
      rewriteCount: value.rewriteCount,
      lastRewrite: value.lastRewrite,
      routerExportKey: value.routerExportKey,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const compatibility = getPatchCompatibilityInfo();
  log("INFO", "validated Codex patch compatibility", compatibility);

  const child = launchCodex();
  const removeTerminationHandlers = installTerminationHandlers(child);

  try {
    const result = await injectPatch(compatibility);
    log("INFO", "Codex launched with one-shot thread list patch", {
      limit: result.limit,
      proxy: PROXY || null,
      url: result.patchedUrl,
      patchKind: result.patchKind,
      rewriteCount: result.rewriteCount,
      lastRewrite: result.lastRewrite,
      routerExportKey: result.routerExportKey,
    });
    console.log(
      `Codex launched with one-shot thread list patch. limit=${result.limit} proxy=${PROXY || "disabled"} patch=${result.patchKind} rewriteCount=${result.rewriteCount}`,
    );
    if (!BACKGROUND) {
      log("INFO", "Codex is running in foreground; terminal will stay attached", {
        pid: child.pid ?? null,
      });
      await new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => {
          log("INFO", "Codex process exited", { code, signal });
          if (code === 0 || signal != null) {
            resolve();
            return;
          }
          reject(new Error(`Codex exited with code ${code}`));
        });
        child.once("error", reject);
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log("ERROR", "launcher failed", { reason });
    await terminateLaunchedCodex(child, reason);
    throw error;
  } finally {
    removeTerminationHandlers();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
