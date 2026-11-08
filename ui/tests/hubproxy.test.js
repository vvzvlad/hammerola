// @vitest-environment node
// ui/hubproxy.mjs — `make proxy`: /_v/* from a local directory, everything
// else from the hub. Run as the Makefile runs it, a node process, in front of a
// stand-in hub on a free port.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../hubproxy.mjs', import.meta.url))

/** A server on a free port of 127.0.0.1, and its port. */
async function listening(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** `{ status, body }` of a request to `port`. */
function request(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('the local hub proxy', () => {
  const heard = []
  let hub
  let proxy
  let port
  let dir

  beforeAll(async () => {
    // The stand-in hub answers every request with its method, path and body.
    hub = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        heard.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
        res.end(`hub ${req.method} ${req.url}`)
      })
    })
    const hubPort = await listening(hub)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubproxy-'))
    fs.writeFileSync(path.join(dir, 'ecad-viewer.js'), 'the checkout\'s build')
    proxy = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${hubPort}`, '0', dir])
    port = await new Promise((resolve, reject) => {
      proxy.stdout.once('data', (line) => resolve(Number(/127\.0\.0\.1:(\d+)/.exec(String(line))[1])))
      proxy.once('exit', (code) => reject(new Error(`the proxy exited with ${code}`)))
    })
  })

  afterAll(() => {
    proxy.kill()
    hub.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serves /_v/ from the directory it is given', async () => {
    expect(await request(port, '/_v/ecad-viewer.js')).toEqual({ status: 200, body: 'the checkout\'s build' })
  })

  it('listens on the address given after the directory, as `make proxy PROXY_HOST=` passes it', async () => {
    const wide = spawn(process.execPath, [SCRIPT, 'http://127.0.0.1:9', '0', dir, '0.0.0.0'])
    try {
      const line = await new Promise((resolve, reject) => {
        wide.stdout.once('data', (data) => resolve(String(data)))
        wide.once('exit', (code) => reject(new Error(`the proxy exited with ${code}`)))
      })
      expect(line).toMatch(/^http:\/\/0\.0\.0\.0:\d+\//)
      expect((await request(Number(/:(\d+)\//.exec(line)[1]), '/_v/ecad-viewer.js')).status).toBe(200)
    } finally {
      wide.kill()
    }
  })

  it('takes from the hub a /_v/ file the directory has not, and every other request, its body included', async () => {
    expect((await request(port, '/_v/hammerola.js')).body).toBe('hub GET /_v/hammerola.js')
    expect((await request(port, '/project/p1/latest/?d=x')).body).toBe('hub GET /project/p1/latest/?d=x')
    expect((await request(port, '/_v/..%2fMakefile')).body).toBe('hub GET /_v/..%2fMakefile')
    await request(port, '/api/comment', { method: 'POST', body: 'a comment' })
    expect(heard.at(-1)).toEqual({ method: 'POST', url: '/api/comment', body: 'a comment' })
  })

  it('answers 502 while the hub is down, and goes on serving', async () => {
    await new Promise((resolve) => hub.close(resolve))
    expect((await request(port, '/project/p1/latest/')).status).toBe(502)
    expect((await request(port, '/_v/ecad-viewer.js')).status).toBe(200)
  })
})
