#!/usr/bin/env node
/**
 * cc-copilot-proxy — local OpenAI-compatible proxy for Command Code /alpha/generate
 *
 * Lets Copilot CLI use Command Code's Go plan ($5/mo) by translating
 * OpenAI Chat Completions requests into Command Code's native format.
 *
 * Usage:
 *   node proxy.mjs              — start; syncs the VS Code model list in the background
 *   node proxy.mjs --recheck    — forget earlier model checks and test every model again
 *
 * Env vars (optional):
 *   COMMANDCODE_API_KEY     — API key (falls back to ~/.commandcode/auth.json)
 *   CC_PROXY_PORT           — listen port (default 5959)
 *   CC_PROXY_VSCODE_MODELS_FILE — VS Code chatLanguageModels.json to keep in sync
 *
 * Then point Copilot CLI at it:
 *   export COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:5959"
 *   export COPILOT_MODEL="deepseek/deepseek-v4-flash"
 *   copilot
 */

import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ── Config ─────────────────────────────────────────────────────────────

const API_BASE = "https://api.commandcode.ai"
const MODELS_URL = `${API_BASE}/provider/v1/models`
const PORT = parseInt(process.env.CC_PROXY_PORT ?? "5959", 10)
const CC_CLI_VERSION = "0.29.0"
const DEFAULT_MAX_TOKENS = 64_000
const LOG_REQUESTS = process.env.CC_PROXY_DEBUG === "1"

function log(...args) {
  if (LOG_REQUESTS) console.error("[proxy]", ...args)
}

// ── API key ────────────────────────────────────────────────────────────

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function getApiKey() {
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY

  const home = homedir()
  const paths = [
    join(home, ".commandcode", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
  ]

  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const obj = JSON.parse(readFileSync(p, "utf-8"))
      if (!isRecord(obj)) continue

      if (typeof obj.apiKey === "string") return obj.apiKey
      if (typeof obj.commandcode === "string") return obj.commandcode

      const cc = obj.commandcode
      if (isRecord(cc) && (cc.type === "oauth" || cc.type === "api")) {
        return cc.access ?? cc.key
      }
      const ccode = obj["command-code"]
      if (isRecord(ccode) && ccode.type === "api") return ccode.key
    } catch {}
  }

  return undefined
}

// ── Model cache ────────────────────────────────────────────────────────

let modelsCache = []

async function refreshModels() {
  try {
    const res = await fetch(MODELS_URL, { headers: { accept: "application/json" } })
    if (!res.ok) return
    const body = await res.json()
    if (isRecord(body) && Array.isArray(body.data)) {
      modelsCache = body.data
      log(`models refreshed: ${modelsCache.length}`)
    }
  } catch (e) {
    log("model refresh failed:", e.message)
  }
}

function openAIModelsResponse() {
  return {
    object: "list",
    data: modelsCache.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created ?? Math.floor(Date.now() / 1000),
      owned_by: "command-code",
    })),
  }
}

// ── OpenAI → CC conversion ────────────────────────────────────────────

function toolsToCC(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  return tools.map((t) => {
    const fn = t.function ?? t
    return {
      type: "function",
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? {},
    }
  })
}

function messagesToCC(messages) {
  const toolCallIds = new Set()
  const resultIds = new Set()
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolCallIds.add(tc.id)
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id)
    }
  }
  const paired = new Set([...toolCallIds].filter((id) => resultIds.has(id)))

  const out = []
  for (const msg of messages) {
    if (msg.role === "system") continue

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n")
            : ""
      out.push({ role: "user", content })
    } else if (msg.role === "assistant") {
      const parts = []

      if (typeof msg.content === "string" && msg.content) {
        parts.push({ type: "text", text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text ?? "" })
          }
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!paired.has(tc.id)) continue
          const args =
            typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments ?? {}
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function?.name ?? "",
            input: args,
          })
        }
      }

      if (parts.length > 0) out.push({ role: "assistant", content: parts })
    } else if (msg.role === "tool") {
      if (!msg.tool_call_id || !paired.has(msg.tool_call_id)) continue
      const output =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n")
            : JSON.stringify(msg.content ?? "")
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id,
            toolName: msg.tool_name ?? msg.name ?? "",
            output: { type: "text", value: output },
          },
        ],
      })
    }
  }
  return out
}

function systemPromptToText(messages) {
  return (messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => {
      if (typeof m.content === "string") return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n")
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function buildCCRequest(openaiBody) {
  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split("T")[0],
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: openaiBody.model,
      messages: messagesToCC(openaiBody.messages ?? []),
      tools: toolsToCC(openaiBody.tools),
      system: systemPromptToText(openaiBody.messages),
      max_tokens: openaiBody.max_tokens ?? openaiBody.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: openaiBody.temperature ?? 0.3,
      stream: openaiBody.stream ?? false,
    },
    threadId: randomUUID(),
  }
}

// ── CC SSE → OpenAI SSE ────────────────────────────────────────────────

function ccEventToOpenAIChunk(event, model, chatId) {
  if (!isRecord(event)) return null

  const base = { id: chatId, object: "chat.completion.chunk", model }

  switch (event.type) {
    case "text-delta": {
      return {
        ...base,
        choices: [{ index: 0, delta: { content: event.text ?? "" } }],
      }
    }

    case "tool-call": {
      const args = event.input ?? event.args ?? event.arguments ?? {}
      const argsStr = typeof args === "string" ? args : JSON.stringify(args)
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: event.toolCallId ?? "",
                  type: "function",
                  function: { name: event.toolName ?? "", arguments: argsStr },
                },
              ],
            },
          },
        ],
      }
    }

    case "finish": {
      const usage = event.totalUsage
      const reason = event.finishReason
      const finishReason =
        reason === "tool-calls"
          ? "tool_calls"
          : reason === "length" || reason === "max_tokens"
            ? "length"
            : "stop"

      const chunk = {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      }
      if (usage) {
        chunk.usage = {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      }
      return chunk
    }

    default:
      return null // skip reasoning, start-step, finish-step, etc.
  }
}

// ── Non-streaming response (accumulate streaming events) ───────────────

function ccHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "x-command-code-version": CC_CLI_VERSION,
    "x-cli-environment": "production",
  }
}

async function nonStreamingResponse(model, apiKey, ccBody) {
  const streamBody = {
    ...ccBody,
    params: { ...ccBody.params, stream: true },
  }

  log("non-streaming fetch:", API_BASE + "/alpha/generate", "model:", model)

  const res = await fetch(`${API_BASE}/alpha/generate`, {
    method: "POST",
    headers: ccHeaders(apiKey),
    body: JSON.stringify(streamBody),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => "")
    log("CC error:", res.status, err.slice(0, 500))
    return {
      status: res.status,
      body: { error: { message: `CC API error ${res.status}: ${err.slice(0, 500)}`, type: "api_error" } },
    }
  }

  const reader = res.body?.getReader()
  if (!reader) {
    return { status: 500, body: { error: { message: "No response body", type: "api_error" } } }
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let textContent = ""
  const toolCalls = []
  let finishReason = "stop"
  let usage = null
  let eventCount = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        let trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(":")) continue
        if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
        if (!trimmed || trimmed === "[DONE]") continue

        try {
          const event = JSON.parse(trimmed)
          eventCount++

          if (event.type === "text-delta") {
            textContent += event.text ?? ""
          } else if (event.type === "tool-call") {
            const args = event.input ?? event.args ?? event.arguments ?? {}
            toolCalls.push({
              id: event.toolCallId ?? "",
              type: "function",
              function: {
                name: event.toolName ?? "",
                arguments: typeof args === "string" ? args : JSON.stringify(args),
              },
            })
          } else if (event.type === "finish") {
            finishReason =
              event.finishReason === "tool-calls"
                ? "tool_calls"
                : event.finishReason === "length" || event.finishReason === "max_tokens"
                  ? "length"
                  : "stop"
            const u = event.totalUsage
            if (u) {
              usage = {
                prompt_tokens: u.inputTokens ?? 0,
                completion_tokens: u.outputTokens ?? 0,
                total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
              }
            }
          }
        } catch {}
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }

  log("non-streaming done. events:", eventCount, "text:", textContent.slice(0, 100))

  const message = { role: "assistant" }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
    message.content = textContent || null
  } else {
    message.content = textContent
  }

  const response = {
    id: `chatcmpl-${ccBody.threadId.slice(0, 29)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage) response.usage = usage
  return { status: 200, body: response }
}

// ── Streaming response ─────────────────────────────────────────────────

async function streamingResponse(model, apiKey, ccBody, res) {
  log("streaming fetch:", API_BASE + "/alpha/generate", "model:", model)

  let ffRes
  try {
    ffRes = await fetch(`${API_BASE}/alpha/generate`, {
      method: "POST",
      headers: ccHeaders(apiKey),
      body: JSON.stringify(ccBody),
    })
  } catch (e) {
    log("fetch error:", e.message)
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: `CC API unreachable: ${e.message}`, type: "api_error" } }))
    return
  }

  if (!ffRes.ok) {
    const err = await ffRes.text().catch(() => "")
    log("CC stream error:", ffRes.status, err.slice(0, 500))
    res.writeHead(ffRes.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: `CC API error ${ffRes.status}: ${err.slice(0, 500)}`, type: "api_error" } }))
    return
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  const reader = ffRes.body?.getReader()
  if (!reader) {
    res.write(`data: ${JSON.stringify({ error: { message: "No response body" } })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
    return
  }

  const decoder = new TextDecoder()
  let buffer = ""
  const chatId = `chatcmpl-${randomUUID()}`
  let eventCount = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        res.write("data: [DONE]\n\n")
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        let trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(":")) continue
        if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
        if (!trimmed || trimmed === "[DONE]") continue

        try {
          const event = JSON.parse(trimmed)
          eventCount++
          const chunk = ccEventToOpenAIChunk(event, model, chatId)
          if (chunk) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        } catch {}
      }
    }
  } catch (e) {
    log("stream read error:", e.message)
    res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`)
    res.write("data: [DONE]\n\n")
  } finally {
    try { reader.releaseLock() } catch {}
    res.end()
  }

  log("streaming done. events:", eventCount)
}

// ── VS Code model sync ─────────────────────────────────────────────────
//
// VS Code never asks the proxy for its model list; it only reads
// chatLanguageModels.json. So the proxy tests each upstream model once with
// a tiny request, remembers the verdict, and writes the models that work on
// the user's plan into the "Command Code" group of that file.

const VSCODE_GROUP_NAME = "Command Code"
const MODEL_CHECKS_FILE = join(homedir(), ".config", "cc-copilot-proxy", "model-checks.json")
const PROBE_MAX_TOKENS = 16
const PROBE_DELAY_MS = 500
const RECHECK_MODELS = process.argv.includes("--recheck")

function defaultVSCodeModelsFile() {
  const home = homedir()
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code - Insiders", "User", "chatLanguageModels.json")
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming")
    return join(appData, "Code - Insiders", "User", "chatLanguageModels.json")
  }
  return join(home, ".config", "Code - Insiders", "User", "chatLanguageModels.json")
}

const VSCODE_MODELS_FILE = process.env.CC_PROXY_VSCODE_MODELS_FILE ?? defaultVSCodeModelsFile()

function loadModelChecks() {
  try {
    const checks = JSON.parse(readFileSync(MODEL_CHECKS_FILE, "utf-8"))
    return isRecord(checks) ? checks : {}
  } catch {
    return {}
  }
}

function saveModelChecks(checks) {
  mkdirSync(dirname(MODEL_CHECKS_FILE), { recursive: true })
  writeFileSync(MODEL_CHECKS_FILE, JSON.stringify(checks, null, 2) + "\n")
}

// The upstream stream can report an error inside a 200 response.
function findStreamError(streamText) {
  for (const line of streamText.split("\n")) {
    let trimmed = line.trim()
    if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === "error") return JSON.stringify(event.error ?? event)
    } catch {}
  }
  return null
}

// Outcomes: "approved" and "rejected" are remembered; "no-credits" and
// "unknown" are retried on the next start.
function classifyProbeError(status, message) {
  if (/insufficient credits/i.test(message)) return { outcome: "no-credits", reason: message }
  if (status === 401 || status === 408 || status === 429 || status >= 500) {
    return { outcome: "unknown", reason: `HTTP ${status}: ${message}` }
  }
  return { outcome: "rejected", reason: `HTTP ${status}: ${message}` }
}

async function probeModel(modelId, apiKey) {
  const ccBody = buildCCRequest({
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  })

  let res
  try {
    res = await fetch(`${API_BASE}/alpha/generate`, {
      method: "POST",
      headers: ccHeaders(apiKey),
      body: JSON.stringify(ccBody),
    })
  } catch (e) {
    return { outcome: "unknown", reason: e.message }
  }

  const text = await res.text().catch(() => "")
  if (!res.ok) return classifyProbeError(res.status, text.slice(0, 300))

  const streamError = findStreamError(text)
  if (streamError) return classifyProbeError(400, streamError.slice(0, 300))
  return { outcome: "approved", reason: "answered" }
}

// "Insufficient credits" is ambiguous: it is what a plan returns for a model
// it does not cover, but also what every model returns once the account has
// no credits at all. It only means "not on your plan" if some model still works.
async function accountStillHasCredits(approvedThisRun, checks, apiKey) {
  if (approvedThisRun > 0) return true
  const knownGoodModel = Object.keys(checks).find((id) => checks[id].status === "approved")
  if (!knownGoodModel) return false
  const result = await probeModel(knownGoodModel, apiKey)
  return result.outcome === "approved"
}

async function checkNewModels(models, checks, apiKey) {
  console.log(`[model sync] Checking ${models.length} model(s) against your plan...`)
  const creditRefusedIds = []
  let approvedThisRun = 0

  for (const model of models) {
    const result = await probeModel(model.id, apiKey)
    log("probe", model.id, result.outcome, result.reason)

    if (result.outcome === "approved" || result.outcome === "rejected") {
      checks[model.id] = { status: result.outcome, reason: result.reason, checkedAt: new Date().toISOString() }
      if (result.outcome === "approved") approvedThisRun++
    } else if (result.outcome === "no-credits") {
      creditRefusedIds.push(model.id)
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS))
  }

  if (creditRefusedIds.length > 0) {
    if (await accountStillHasCredits(approvedThisRun, checks, apiKey)) {
      for (const id of creditRefusedIds) {
        checks[id] = { status: "rejected", reason: "not covered by plan", checkedAt: new Date().toISOString() }
      }
    } else {
      console.log(`[model sync] Account has no credits; ${creditRefusedIds.length} model(s) will be rechecked next start.`)
    }
  }

  saveModelChecks(checks)
}

function vscodeModelEntry(model) {
  const contextLength = model.context_length ?? 128_000
  return {
    id: model.id,
    name: model.name ?? model.id,
    url: `http://127.0.0.1:${PORT}/v1/chat/completions`,
    toolCalling: true,
    vision: false,
    maxInputTokens: contextLength,
    maxOutputTokens: Math.min(DEFAULT_MAX_TOKENS, contextLength),
  }
}

function readVSCodeModelGroups() {
  if (!existsSync(VSCODE_MODELS_FILE)) return { groups: [], previousText: "" }
  const previousText = readFileSync(VSCODE_MODELS_FILE, "utf-8")
  const groups = JSON.parse(previousText)
  if (!Array.isArray(groups)) throw new Error("top level is not an array")
  return { groups, previousText }
}

function writeVSCodeModels(checks) {
  // No approved model at all means nothing could be checked yet; keep what the user has.
  if (!modelsCache.some((m) => checks[m.id]?.status === "approved")) return
  if (!existsSync(dirname(VSCODE_MODELS_FILE))) {
    log("VS Code Insiders user folder not found, skipping:", dirname(VSCODE_MODELS_FILE))
    return
  }

  let groups
  let previousText
  try {
    ;({ groups, previousText } = readVSCodeModelGroups())
  } catch (e) {
    console.error(`[model sync] Not touching ${VSCODE_MODELS_FILE}: ${e.message}`)
    return
  }

  let group = groups.find((g) => isRecord(g) && g.name === VSCODE_GROUP_NAME)
  if (!group) {
    group = {
      name: VSCODE_GROUP_NAME,
      vendor: "customendpoint",
      apiKey: "proxy-handles-auth",
      apiType: "chat-completions",
      models: [],
    }
    groups.push(group)
  }

  // Entries already in the file win, so hand-edited settings (vision, token limits) survive.
  // Models not checked yet (for example after a network error) keep their place until they are.
  const existingById = new Map((group.models ?? []).map((m) => [m.id, m]))
  const shownModels = modelsCache.filter((m) => {
    const status = checks[m.id]?.status
    return status === "approved" || (status === undefined && existingById.has(m.id))
  })
  group.models = shownModels.map((m) => existingById.get(m.id) ?? vscodeModelEntry(m))

  const nextText = JSON.stringify(groups, null, 2) + "\n"
  if (nextText === previousText) return

  if (previousText) writeFileSync(`${VSCODE_MODELS_FILE}.bak`, previousText)
  writeFileSync(VSCODE_MODELS_FILE, nextText)

  const shownIds = new Set(shownModels.map((m) => m.id))
  const addedCount = shownModels.filter((m) => !existingById.has(m.id)).length
  const removedCount = [...existingById.keys()].filter((id) => !shownIds.has(id)).length
  console.log(
    `[model sync] VS Code model list updated (${addedCount} added, ${removedCount} removed). ` +
      `Run "Developer: Reload Window" in VS Code to see it.`,
  )
}

let modelSyncRunning = false

async function syncVSCodeModels(apiKey) {
  if (modelSyncRunning || modelsCache.length === 0) return
  modelSyncRunning = true
  try {
    const checks = loadModelChecks()
    const untestedModels = modelsCache.filter((m) => !checks[m.id])
    if (untestedModels.length > 0) await checkNewModels(untestedModels, checks, apiKey)
    writeVSCodeModels(checks)
  } catch (e) {
    console.error("[model sync] failed:", e.message)
  } finally {
    modelSyncRunning = false
  }
}

// ── HTTP handlers ──────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

async function handleChatCompletions(req, res, apiKey) {
  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString()
    if (body.length > 1_000_000) req.destroy()
  })

  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body)
      log("request model:", parsed.model, "stream:", parsed.stream, "msgs:", parsed.messages?.length)
      const ccBody = buildCCRequest(parsed)

      if (parsed.stream) {
        await streamingResponse(parsed.model, apiKey, ccBody, res)
      } else {
        const result = await nonStreamingResponse(parsed.model, apiKey, ccBody)
        sendJSON(res, result.status, result.body)
      }
    } catch (e) {
      log("request error:", e.message)
      sendJSON(res, 400, {
        error: { message: `Invalid request: ${e.message}`, type: "invalid_request_error" },
      })
    }
  })
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const apiKey = getApiKey()
  if (!apiKey) {
    console.error("No Command Code API key found.")
    console.error("Set COMMANDCODE_API_KEY env var or create ~/.commandcode/auth.json")
    console.error("Run `pi` then `/login` and select Command Code to set it up.")
    process.exit(1)
  }

  log("API key found, prefix:", apiKey.slice(0, 10))

  if (RECHECK_MODELS) rmSync(MODEL_CHECKS_FILE, { force: true })

  await refreshModels()
  setInterval(async () => {
    await refreshModels()
    await syncVSCodeModels(apiKey)
  }, 5 * 60_000)

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const path = url.pathname

    // GET /v1/models
    if (req.method === "GET" && path === "/v1/models") {
      sendJSON(res, 200, openAIModelsResponse())
      return
    }

    // GET /v1/models/{model_id}  (model IDs can contain /)
    const modelMatch = path.match(/^\/v1\/models\/(.+)/)
    if (req.method === "GET" && modelMatch) {
      const id = decodeURIComponent(modelMatch[1])
      const m = modelsCache.find((m) => m.id === id)
      if (m) {
        sendJSON(res, 200, {
          id: m.id,
          object: "model",
          created: m.created ?? Math.floor(Date.now() / 1000),
          owned_by: "command-code",
        })
      } else {
        sendJSON(res, 404, { error: { message: `Model '${id}' not found`, type: "not_found" } })
      }
      return
    }

    // GET /models (without /v1 prefix — some clients use this)
    if (req.method === "GET" && path === "/models") {
      sendJSON(res, 200, openAIModelsResponse())
      return
    }

    // POST /v1/chat/completions
    if (req.method === "POST" && path === "/v1/chat/completions") {
      handleChatCompletions(req, res, apiKey)
      return
    }

    // POST /chat/completions (without /v1 prefix)
    if (req.method === "POST" && path === "/chat/completions") {
      handleChatCompletions(req, res, apiKey)
      return
    }

    // GET /health
    if (req.method === "GET" && path === "/health") {
      sendJSON(res, 200, { status: "ok", models: modelsCache.length })
      return
    }

    log("404:", req.method, path)
    res.writeHead(404)
    res.end("Not found")
  })

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`CC Proxy: http://127.0.0.1:${PORT}`)
    console.log(`Models: ${modelsCache.length} loaded`)
    console.log(`\nCopilot CLI setup:`)
    console.log(`  export COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:${PORT}"`)
    console.log(`  export COPILOT_MODEL="deepseek/deepseek-v4-flash"`)
    console.log(`  copilot`)
    console.log()
    syncVSCodeModels(apiKey)
  })
}

main().catch((e) => {
  console.error("Fatal:", e.message)
  process.exit(1)
})
