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

function getCandidateAppServerManagerAssetUrls() {
  const asarPath = getAppAsarPath();
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(
    buffer.subarray(16, 16 + headerSize).toString("utf8"),
  );
  const urls = [];

  const walk = (node, prefix = "") => {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, prefix ? `${prefix}/${name}` : name);
      }
      return;
    }

    if (/^webview\/assets\/app-server-manager-.*\.js$/.test(prefix)) {
      urls.push(`app://-/${prefix.replace(/^webview\//, "")}`);
    }
  };

  walk(header);
  urls.sort((left, right) => {
    const score = (url) =>
      url.includes("-signals-") ? 0 : url.includes("-hooks-") ? 1 : 2;
    return score(left) - score(right) || left.localeCompare(right);
  });

  if (urls.length === 0) {
    throw new Error(`No app-server-manager assets found in ${asarPath}`);
  }

  return { asarPath, urls };
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

function buildRuntimePrototypePatchExpression(url) {
  return `
(async () => {
  const limit = ${THREAD_LIMIT};
  const moduleUrl = ${JSON.stringify(url)};
  const mod = await import(moduleUrl);
  const patchedManagers = [];

  const patchRecentConversations = (manager) => {
    const recentConversations = manager?.recentConversations;
    if (recentConversations == null) {
      return false;
    }
    if (recentConversations.__codexAllThreadsPatched === limit) {
      return false;
    }

    const originalListRecentThreads = recentConversations.listRecentThreads;
    if (typeof originalListRecentThreads !== "function") {
      return false;
    }

    Object.defineProperty(recentConversations, "__codexAllThreadsPatched", {
      value: limit,
      configurable: true,
    });
    Object.defineProperty(
      recentConversations,
      "__codexAllThreadsOriginalListRecentThreads",
      {
        value: originalListRecentThreads,
        configurable: true,
      },
    );

    recentConversations.listRecentThreads = function listRecentThreads(params = {}) {
      const requestedLimit = Number(params.limit) || 0;
      return originalListRecentThreads.call(this, {
        ...params,
        limit: Math.max(requestedLimit, limit),
      });
    };

    return true;
  };

  const queueRefreshIfNeeded = (manager) => {
    if (manager == null || manager.__codexAllThreadsRefreshQueued === true) {
      return;
    }
    if (typeof manager.refreshRecentConversations !== "function") {
      return;
    }

    const recentConversations = manager.recentConversations;
    const hasMore =
      typeof recentConversations?.hasMoreRecentConversations === "function"
        ? recentConversations.hasMoreRecentConversations()
        : true;
    if (!hasMore) {
      return;
    }

    Object.defineProperty(manager, "__codexAllThreadsRefreshQueued", {
      value: true,
      configurable: true,
    });
    Promise.resolve().then(() => {
      manager.refreshRecentConversations().catch((error) => {
        window.__codexAllThreadsRefreshError = String(error);
      });
    });
  };

  const wrap = (proto, methodName) => {
    const original = proto?.[methodName];
    if (typeof original !== "function" || original.__codexAllThreadsWrapped) {
      return false;
    }

    const wrapped = function wrappedCodexAllThreadsMethod(...args) {
      patchRecentConversations(this);
      if (methodName === "getRecentConversations") {
        queueRefreshIfNeeded(this);
      }
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, "__codexAllThreadsWrapped", {
      value: true,
      configurable: true,
    });
    proto[methodName] = wrapped;
    return true;
  };

  for (const [key, value] of Object.entries(mod)) {
    const proto = value?.prototype;
    const isAppServerManager =
      proto != null &&
      typeof proto.refreshRecentConversations === "function" &&
      typeof proto.runRecentConversationRefresh === "function" &&
      typeof proto.loadMoreRecentConversations === "function" &&
      typeof proto.getRecentConversations === "function";

    if (!isAppServerManager) {
      continue;
    }

    const wrappedMethods = [
      "refreshRecentConversations",
      "runRecentConversationRefresh",
      "loadMoreRecentConversations",
      "getRecentConversations",
      "hasMoreRecentConversations",
    ].filter((methodName) => wrap(proto, methodName));

    patchedManagers.push({
      key,
      name: value.name || null,
      wrappedMethods,
    });
  }

  if (patchedManagers.length === 0) {
    return {
      limit,
      patchKind: "runtime-prototype",
      url: moduleUrl,
      patched: false,
      reason: "No matching AppServerManager export found",
      exportKeys: Object.keys(mod).slice(0, 100),
    };
  }

  window.__codexAllThreadsPatchInfo = {
    limit,
    patchKind: "runtime-prototype",
    url: moduleUrl,
    patchedManagers,
  };
  return window.__codexAllThreadsPatchInfo;
})()
`;
}

async function injectPatch() {
  const target = await waitForTarget();
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  const { asarPath, urls: candidateAssetUrls } =
    getCandidateAppServerManagerAssetUrls();

  try {
    await client.send("Runtime.enable");
    log("INFO", "installing runtime prototype patch", {
      asarPath,
      candidateAssetUrls,
    });

    for (const url of candidateAssetUrls) {
      const result = await client.send("Runtime.evaluate", {
        expression: buildRuntimePrototypePatchExpression(url),
        awaitPromise: true,
        returnByValue: true,
      });

      const value = result?.result?.value || null;
      if (value?.limit === THREAD_LIMIT && value?.patchedManagers?.length > 0) {
        log("INFO", "installed runtime recent-conversation patch", value);
        return {
          patchedUrl: value.url,
          limit: value.limit,
          patchKind: value.patchKind,
          patchedManagers: value.patchedManagers,
        };
      }

      log("INFO", "candidate asset did not expose patch target", {
        url,
        result: value,
      });
    }

    const result = await client.send("Runtime.evaluate", {
      expression: "window.__codexAllThreadsPatchInfo ?? null",
      awaitPromise: false,
      returnByValue: true,
    });
    const value = result?.result?.value || null;
    if (value?.limit === THREAD_LIMIT && value?.patchedManagers?.length > 0) {
      return {
        patchedUrl: value.url,
        limit: value.limit,
        patchKind: value.patchKind,
        patchedManagers: value.patchedManagers,
      };
    }

    throw new Error("Failed to install runtime recent-conversation patch");
  } finally {
    client.close();
  }
}

async function main() {
  const child = launchCodex();
  const removeTerminationHandlers = installTerminationHandlers(child);

  try {
    const result = await injectPatch();
    log("INFO", "Codex launched with one-shot thread list patch", {
      limit: result.limit,
      proxy: PROXY || null,
      url: result.patchedUrl,
      patchKind: result.patchKind,
      patchedManagers: result.patchedManagers,
    });
    console.log(
      `Codex launched with one-shot thread list patch. limit=${result.limit} proxy=${PROXY || "disabled"} url=${result.patchedUrl}`,
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
