/**
 * Minimal OpenAI-compatible chat-completions SSE server, for driving the guard
 * over the STOCK @deepseek-ai/dsh-llm-pi-ai access layer.
 *
 * No dependencies, no external network. The requested model id selects the
 * scenario, and every request is appended to requests.log with a millisecond
 * timestamp, which is what makes an automatic retry observable as a fact rather
 * than as a log line the guard wrote about itself.
 *
 * Usage: node server.mjs <port> <logFile>
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 18777)
const logFile = process.argv[3] ?? 'requests.log'
let seq = 0
let runSeq = 0

const log = (line) => appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n')

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

function chunk(model, delta, finish = null) {
  return { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function stream(req, res, model, n) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  sse(res, chunk(model, { role: 'assistant' }))

  if (model === 'scenario-503-once') {
    // Succeeds, but only after the failing request that the retry tier is
    // supposed to absorb. Reaching this point at all is the evidence.
    sse(res, chunk(model, { content: 'MOCK-503-RECOVERED' }))
    sse(res, chunk(model, {}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (model === 'scenario-degenerate') {
    // 60 clauses that are nothing but an intent announcement. The announce rule
    // needs 5 hits within 20 non-whitespace characters; consecutive repetitions
    // leave no gap at all, so it fires on the fifth.
    for (let i = 0; i < 60; i++) {
      sse(res, chunk(model, { content: 'Let me check. ' }))
      await sleep(5)
    }
    sse(res, chunk(model, {}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (model === 'scenario-idle') {
    // Reasoning only: no content delta, no tool call. The loop reads
    // "toolCalls.length === 0" as a completed turn.
    const text = 'Considering the request at length, weighing the alternatives, and reaching a conclusion that is never written down. '
    for (let i = 0; i < 40; i++) {
      sse(res, chunk(model, { reasoning_content: text }))
      await sleep(2)
    }
    sse(res, chunk(model, {}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (model === 'scenario-empty') {
    // Terminal stop with no content blocks.
    sse(res, chunk(model, {}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  sse(res, chunk(model, { content: 'MOCK-DEFAULT-' + n }))
  sse(res, chunk(model, {}, 'stop'))
  res.write('data: [DONE]\n\n')
  res.end()
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    if (req.url.includes('/control/reset')) {
      runSeq = 0
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('reset')
      return
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    let model = 'unknown'
    try { model = JSON.parse(body).model } catch {}
    seq += 1
    const n = seq
    runSeq += 1
    log('#' + n + ' model=' + model + ' path=' + req.url)

    if (model === 'scenario-503-first') {
      if (runSeq === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"mock upstream unavailable","type":"server_error"}}')
        return
      }
      await stream(req, res, 'scenario-503-once', n)
      return
    }
    await stream(req, res, model, n)
  })
}).listen(port, '127.0.0.1', () => log('listening on ' + port))
