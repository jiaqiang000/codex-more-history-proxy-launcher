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
  let hasLoadRecentConversationIds = false;
  let vscodeApiAssetPath = null;
  let appServerManagerSignalsAssetPath = null;

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
    if (/^webview\/assets\/app-server-manager-signals-.*\.js$/.test(filePath)) {
      appServerManagerSignalsAssetPath = filePath;
    }

    const text = readAsarText(asar, filePath, node);
    hasMcpRequest ||= text.includes("mcp-request");
    hasSendMessageFromView ||= text.includes("sendMessageFromView");
    hasThreadList ||= text.includes("thread/list");
    hasLoadRecentConversationIds ||= text.includes(
      "load-recent-conversation-ids-for-host",
    );
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
  if (!appServerManagerSignalsAssetPath) {
    missing.push("app-server-manager-signals asset");
  }
  if (!hasLoadRecentConversationIds) {
    missing.push("load-recent-conversation-ids-for-host action");
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
    appServerManagerSignalsUrl: `app://-/${appServerManagerSignalsAssetPath.replace(
      /^webview\//,
      "",
    )}`,
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

function buildRouterDispatchPatchSource(vscodeApiUrl, appServerManagerSignalsUrl) {
  return `
(() => {
  const limit = ${THREAD_LIMIT};
  const apiUrl = ${JSON.stringify(vscodeApiUrl)};
  const appServerManagerSignalsUrl = ${JSON.stringify(appServerManagerSignalsUrl)};
  const patchKind = "router-dispatch-paginate";
  const stateKey = "__codexAllThreadsPatchInfo";
  const info = {
    limit,
    patchKind,
    apiUrl,
    installed: false,
    installError: null,
    installAttempts: 0,
    rewriteCount: 0,
    lastRewrite: null,
    observedThreadListResponseCount: 0,
    deliveredThreadListCount: 0,
    aggregatedResponseCount: 0,
    internalPageRequestCount: 0,
    internalPageResponseCount: 0,
    internalPageErrorCount: 0,
    forceLoadState: "idle",
    forceLoadRequestCount: 0,
    forceLoadLoadedCount: 0,
    forceLoadMissingCount: null,
    forceLoadError: null,
    lastForceLoad: null,
    manualLoadState: "idle",
    manualLoadError: null,
    lastManualLoad: null,
    lastAggregation: null,
    lastDelivery: null,
    routerExportKey: null,
  };
  window[stateKey] = info;

  const trackedRequests = new Map();
  const internalResolvers = new Map();
  let forceLoadScheduled = false;
  let manualLoadStarted = false;

  const getMessageId = (payload) => payload?.message?.id;
  const getResultValue = (payload) => {
    const result = payload?.message?.result;
    if (result == null) {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
  };
  const isThreadListValue = (value) =>
    value != null &&
    typeof value === "object" &&
    Array.isArray(value.data) &&
    Object.prototype.hasOwnProperty.call(value, "nextCursor");

  const clonePayloadWithValue = (payload, value) => {
    const result = payload.message.result;
    const nextResult =
      result != null &&
      typeof result === "object" &&
      Object.prototype.hasOwnProperty.call(result, "value")
        ? {
            ...result,
            value,
          }
        : value;

    return {
      ...payload,
      message: {
        ...payload.message,
        result: nextResult,
      },
    };
  };

  const rememberDelivery = (requestId, value, details) => {
    info.deliveredThreadListCount += 1;
    info.lastDelivery = {
      requestId: String(requestId || ""),
      total: Array.isArray(value?.data) ? value.data.length : null,
      nextCursor: value?.nextCursor ?? null,
      at: new Date().toISOString(),
      ...details,
    };
  };

  const uniqueThreadIds = (items) => {
    const ids = [];
    const seen = new Set();
    for (const item of items || []) {
      const id = item?.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };

  const forceLoadRecentConversationIds = async (items) => {
    if (forceLoadScheduled) {
      return;
    }

    const conversationIds = uniqueThreadIds(items);
    if (conversationIds.length === 0) {
      info.forceLoadState = "completed";
      info.lastForceLoad = {
        totalIds: 0,
        loaded: 0,
        missing: 0,
        at: new Date().toISOString(),
      };
      return;
    }

    forceLoadScheduled = true;
    info.forceLoadState = "scheduled";
    info.lastForceLoad = {
      totalIds: conversationIds.length,
      loaded: 0,
      missing: conversationIds.length,
      at: new Date().toISOString(),
    };

    await new Promise((resolve) => window.setTimeout(resolve, 250));

    info.forceLoadState = "running";
    info.forceLoadRequestCount += 1;
    try {
      const signals = await import(appServerManagerSignalsUrl);
      if (typeof signals.rn !== "function") {
        throw new Error("Codex app action dispatcher export was not found");
      }

      const loaded = await signals.rn("load-recent-conversation-ids-for-host", {
        hostId: "local",
        conversationIds,
      });
      const loadedIds = Array.isArray(loaded) ? loaded : [];
      const loadedSet = new Set(loadedIds);
      const missing = conversationIds.filter((id) => !loadedSet.has(id));
      info.forceLoadState = missing.length === 0 ? "completed" : "failed";
      info.forceLoadLoadedCount = loadedIds.length;
      info.forceLoadMissingCount = missing.length;
      info.forceLoadError =
        missing.length === 0
          ? null
          : \`Codex only loaded \${loadedIds.length}/\${conversationIds.length} recent conversations\`;
      info.lastForceLoad = {
        totalIds: conversationIds.length,
        loaded: loadedIds.length,
        missing: missing.length,
        missingSample: missing.slice(0, 10),
        at: new Date().toISOString(),
      };
    } catch (error) {
      info.forceLoadState = "failed";
      info.forceLoadError = String(error?.message || error);
      info.lastForceLoad = {
        totalIds: conversationIds.length,
        loaded: info.forceLoadLoadedCount,
        missing: conversationIds.length,
        error: info.forceLoadError,
        at: new Date().toISOString(),
      };
    }
  };

  const shouldTrackRequest = (type, payload) => {
    if (type !== "mcp-request") {
      return false;
    }

    const request = payload?.request;
    if (request?.method !== "thread/list") {
      return false;
    }

    const params = request.params;
    if (
      params == null ||
      typeof params !== "object" ||
      params.archived !== false
    ) {
      return false;
    }

    return !internalResolvers.has(request.id);
  };

  const rewritePayload = (type, payload) => {
    if (!shouldTrackRequest(type, payload)) {
      return payload;
    }

    const request = payload.request;
    const params = request.params;

    const currentLimit = Number(params.limit);
    if (
      !Number.isFinite(currentLimit) ||
      currentLimit <= 0 ||
      currentLimit >= limit
    ) {
      trackedRequests.set(request.id, {
        hostId: payload.hostId,
        params: { ...params, limit },
        requestedLimit: limit,
      });
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
    trackedRequests.set(request.id, {
      hostId: payload.hostId,
      params: nextPayload.request.params,
      requestedLimit: limit,
    });
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

      if (
        router.dispatchMessage.__codexAllThreadsPatched === limit &&
        router.deliverMessage.__codexAllThreadsPatched === limit &&
        router.__codexAllThreadsPatchKind === patchKind
      ) {
        info.installed = true;
        info.routerExportKey = routerExportKey;
        return info;
      }

      const original = router.dispatchMessage;
      const originalDeliver = router.deliverMessage;

      const sendInternalThreadListPage = (hostId, params) => {
        const requestId = crypto.randomUUID();
        info.internalPageRequestCount += 1;

        return new Promise((resolve) => {
          const timer = window.setTimeout(() => {
            internalResolvers.delete(requestId);
            info.internalPageErrorCount += 1;
            resolve({
              ok: false,
              error: "Timed out waiting for internal thread/list page",
            });
          }, 15000);

          internalResolvers.set(requestId, {
            resolve,
            timer,
          });

          original.call(router, "mcp-request", {
            hostId,
            request: {
              id: requestId,
              method: "thread/list",
              params,
            },
          });
        });
      };

      const readAllRecentThreadPages = async () => {
        const seenIds = new Set();
        const merged = [];
        const addPage = (items) => {
          for (const item of items) {
            if (item?.id == null || seenIds.has(item.id)) {
              continue;
            }
            seenIds.add(item.id);
            merged.push(item);
          }
        };

        let pages = 0;
        let nextCursor = null;
        do {
          const response = await sendInternalThreadListPage("local", {
            limit,
            cursor: nextCursor,
            sortKey: "updated_at",
            modelProviders: null,
            archived: false,
            sourceKinds: ["vscode"],
          });

          if (!response.ok || !isThreadListValue(response.value)) {
            throw new Error(
              response.error || "Manual thread/list response shape changed",
            );
          }

          pages += 1;
          addPage(response.value.data);
          nextCursor = response.value.nextCursor ?? null;
        } while (nextCursor != null && merged.length < limit && pages < 100);

        return {
          data: merged,
          nextCursor,
          pages,
        };
      };

      window.__codexAllThreadsLoadAllRecentConversations = async () => {
        if (forceLoadScheduled || manualLoadStarted) {
          return info;
        }

        manualLoadStarted = true;
        info.manualLoadState = "running";
        info.manualLoadError = null;
        info.lastManualLoad = {
          total: 0,
          pages: 0,
          nextCursor: null,
          at: new Date().toISOString(),
        };

        try {
          const value = await readAllRecentThreadPages();
          info.manualLoadState = "completed";
          info.lastManualLoad = {
            total: value.data.length,
            pages: value.pages,
            nextCursor: value.nextCursor,
            at: new Date().toISOString(),
          };
          await forceLoadRecentConversationIds(value.data);
        } catch (error) {
          info.manualLoadState = "failed";
          info.manualLoadError = String(error?.message || error);
          info.lastManualLoad = {
            ...(info.lastManualLoad || {}),
            error: info.manualLoadError,
            at: new Date().toISOString(),
          };
        }

        return info;
      };

      const aggregateAndDeliver = async (
        thisArg,
        type,
        payload,
        tracked,
        firstValue,
        rest,
      ) => {
        const seenIds = new Set();
        const merged = [];
        const addPage = (items) => {
          for (const item of items) {
            if (item?.id == null || seenIds.has(item.id)) {
              continue;
            }
            seenIds.add(item.id);
            merged.push(item);
          }
        };

        let nextCursor = firstValue.nextCursor ?? null;
        let pages = 1;
        addPage(firstValue.data);

        while (nextCursor != null && merged.length < limit && pages < 100) {
          const response = await sendInternalThreadListPage(tracked.hostId, {
            ...tracked.params,
            cursor: nextCursor,
            limit,
          });

          if (!response.ok) {
            info.lastAggregation = {
              requestId: String(getMessageId(payload) || ""),
              pages,
              total: merged.length,
              nextCursor,
              error: response.error,
              at: new Date().toISOString(),
            };
            break;
          }

          const value = response.value;
          if (!isThreadListValue(value)) {
            info.internalPageErrorCount += 1;
            info.lastAggregation = {
              requestId: String(getMessageId(payload) || ""),
              pages,
              total: merged.length,
              nextCursor,
              error: "Internal thread/list page response shape changed",
              at: new Date().toISOString(),
            };
            break;
          }

          pages += 1;
          addPage(value.data);
          nextCursor = value.nextCursor ?? null;
        }

        const aggregatedValue = {
          ...firstValue,
          data: merged,
          nextCursor: nextCursor ?? null,
        };
        const nextPayload = clonePayloadWithValue(payload, aggregatedValue);
        info.aggregatedResponseCount += 1;
        info.lastAggregation = {
          requestId: String(getMessageId(payload) || ""),
          pages,
          total: merged.length,
          nextCursor: aggregatedValue.nextCursor,
          at: new Date().toISOString(),
        };
        rememberDelivery(getMessageId(payload), aggregatedValue, {
          pages,
          aggregated: true,
        });
        originalDeliver.call(thisArg, type, nextPayload, ...rest);
        forceLoadRecentConversationIds(aggregatedValue.data);
      };

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

      const wrappedDeliver = function codexAllThreadsDeliverMessage(
        type,
        payload,
        ...rest
      ) {
        if (type === "mcp-response") {
          const responseId = getMessageId(payload);
          const internal = internalResolvers.get(responseId);
          if (internal != null) {
            internalResolvers.delete(responseId);
            window.clearTimeout(internal.timer);
            info.internalPageResponseCount += 1;
            const value = getResultValue(payload);
            internal.resolve({
              ok: isThreadListValue(value),
              value,
              error: isThreadListValue(value)
                ? null
                : "Internal thread/list response did not contain data",
            });
            return;
          }

          const tracked = trackedRequests.get(responseId);
          if (tracked != null) {
            trackedRequests.delete(responseId);
            info.observedThreadListResponseCount += 1;

            const value = getResultValue(payload);
            if (!isThreadListValue(value)) {
              return originalDeliver.call(this, type, payload, ...rest);
            }

            if (value.nextCursor == null || value.data.length >= limit) {
              rememberDelivery(responseId, value, {
                pages: 1,
                aggregated: false,
              });
              return originalDeliver.call(this, type, payload, ...rest);
            }

            rememberDelivery(responseId, value, {
              pages: 1,
              aggregated: false,
              hasMore: true,
            });
            originalDeliver.call(this, type, payload, ...rest);
            return;
          }
        }

        return originalDeliver.call(this, type, payload, ...rest);
      };
      Object.defineProperty(wrappedDeliver, "__codexAllThreadsPatched", {
        value: limit,
        configurable: true,
      });
      Object.defineProperty(wrappedDeliver, "__codexAllThreadsOriginal", {
        value: originalDeliver,
        configurable: true,
      });
      router.deliverMessage = wrappedDeliver;
      router.__codexAllThreadsPatchKind = patchKind;

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

async function waitForPatchInstalled(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastInfo = null;

  while (Date.now() < deadline) {
    try {
      lastInfo = await readRuntimePatchInfo(client);
      if (
        lastInfo?.limit === THREAD_LIMIT &&
        lastInfo?.patchKind === "router-dispatch-paginate" &&
        lastInfo?.installed === true
      ) {
        return lastInfo;
      }
    } catch {
      // The page may be between execution contexts while reloading.
    }

    await sleep(250);
  }

  throw new Error(
    `Failed to install expanded thread/list patch after startup reload (lastInfo=${JSON.stringify(
      lastInfo,
    )})`,
  );
}

async function waitForExpandedThreadListResponse(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastInfo = null;

  while (Date.now() < deadline) {
    try {
      lastInfo = await readRuntimePatchInfo(client);
      if (
        lastInfo?.limit === THREAD_LIMIT &&
        lastInfo?.patchKind === "router-dispatch-paginate" &&
        lastInfo?.installed === true &&
        (lastInfo?.lastDelivery != null ||
          lastInfo?.manualLoadState === "completed") &&
        (lastInfo?.lastDelivery == null ||
          lastInfo.lastDelivery.nextCursor == null ||
          lastInfo.lastDelivery.total >= THREAD_LIMIT) &&
        lastInfo?.forceLoadState === "completed"
      ) {
        return lastInfo;
      }

      if (lastInfo?.forceLoadState === "failed") {
        throw new Error(
          `Failed to force-load recent conversations after pagination (lastInfo=${JSON.stringify(
            lastInfo,
          )})`,
        );
      }

      if (lastInfo?.manualLoadState === "failed") {
        throw new Error(
          `Failed to manually load recent conversations after startup reload (lastInfo=${JSON.stringify(
            lastInfo,
          )})`,
        );
      }
    } catch {
      // The page may be between execution contexts while reloading.
    }

    await sleep(250);
  }

  throw new Error(
    `Failed to observe expanded thread/list response after startup reload (lastInfo=${JSON.stringify(
      lastInfo,
    )})`,
  );
}

async function injectPatch(compatibility) {
  const target = await waitForTarget();
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  const patchSource = buildRouterDispatchPatchSource(
    compatibility.vscodeApiUrl,
    compatibility.appServerManagerSignalsUrl,
  );

  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    log("INFO", "installing router dispatch patch", {
      asarPath: compatibility.asarPath,
      vscodeApiUrl: compatibility.vscodeApiUrl,
      appServerManagerSignalsUrl: compatibility.appServerManagerSignalsUrl,
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

    await waitForPatchInstalled(client);
    await client.send("Runtime.evaluate", {
      expression:
        "window.setTimeout(() => { window.__codexAllThreadsLoadAllRecentConversations?.().catch(() => null); }, 2500); true",
      awaitPromise: false,
      returnByValue: true,
    });
    log("INFO", "triggered manual recent-conversation force load");

    const value = await waitForExpandedThreadListResponse(client);
    log("INFO", "observed expanded recent-conversation response", value);

    return {
      patchedUrl: compatibility.vscodeApiUrl,
      limit: value.limit,
      patchKind: value.patchKind,
      rewriteCount: value.rewriteCount,
      aggregatedResponseCount: value.aggregatedResponseCount,
      deliveredThreadListCount: value.deliveredThreadListCount,
      forceLoadState: value.forceLoadState,
      forceLoadLoadedCount: value.forceLoadLoadedCount,
      forceLoadMissingCount: value.forceLoadMissingCount,
      lastForceLoad: value.lastForceLoad,
      manualLoadState: value.manualLoadState,
      lastManualLoad: value.lastManualLoad,
      lastAggregation: value.lastAggregation,
      lastDelivery: value.lastDelivery,
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
    log("INFO", "Codex launched with paginated thread list patch", {
      limit: result.limit,
      proxy: PROXY || null,
      url: result.patchedUrl,
      patchKind: result.patchKind,
      rewriteCount: result.rewriteCount,
      aggregatedResponseCount: result.aggregatedResponseCount,
      deliveredThreadListCount: result.deliveredThreadListCount,
      forceLoadState: result.forceLoadState,
      forceLoadLoadedCount: result.forceLoadLoadedCount,
      forceLoadMissingCount: result.forceLoadMissingCount,
      lastForceLoad: result.lastForceLoad,
      manualLoadState: result.manualLoadState,
      lastManualLoad: result.lastManualLoad,
      lastAggregation: result.lastAggregation,
      lastDelivery: result.lastDelivery,
      lastRewrite: result.lastRewrite,
      routerExportKey: result.routerExportKey,
    });
    console.log(
      `Codex launched with paginated thread list patch. limit=${result.limit} proxy=${PROXY || "disabled"} patch=${result.patchKind} loaded=${result.forceLoadLoadedCount ?? result.lastDelivery?.total ?? "unknown"} pages=${result.lastManualLoad?.pages ?? result.lastDelivery?.pages ?? "unknown"}`,
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
