// A local view of a hammerola hub with this checkout's browser files, for
// trying a change to the page on real projects before it is deployed: /_v/*
// comes from a local directory (static/_v/: its committed assets and what
// `make ui`, `make viewer` and `make ecad` build), every other request goes to
// the hub as it is. The first line it prints is the address it listens on.
//
// usage: node ui/hubproxy.mjs <hub url> <port, 0 for any> <static dir> [<address, 127.0.0.1>]    (`make proxy`)

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const [hubUrl, port, dir, host = '127.0.0.1'] = process.argv.slice(2);
const hub = new URL(hubUrl);
const root = path.resolve(dir);
const client = hub.protocol === 'https:' ? https : http;
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  if (pathname.startsWith('/_v/')) {
    const file = path.join(root, decodeURIComponent(pathname.slice('/_v/'.length)));
    // A file the checkout has not built is the hub's, like everything else.
    if (file.startsWith(root + path.sep) && fs.existsSync(file)) {
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  const upstream = client.request(
    { host: hub.hostname, port: hub.port || undefined, path: req.url, method: req.method,
      headers: { ...req.headers, host: hub.host } },
    (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    },
  );
  // A dropped connection to the hub (it restarting on a deploy) answers 502
  // rather than ending the proxy.
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
server.listen(Number(port), host, () => {
  console.log(`http://${host}:${server.address().port}/ -> ${hub.origin}, /_v/ from ${root}`);
});
