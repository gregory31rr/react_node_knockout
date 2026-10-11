/**
 * test/helpers/fakes3.js — a small S3-compatible server for tests (path-style: /bucket/key).
 * It checks each request the way S3 does: the signature must match, and the body must match its declared hash.
 * Listing returns 2 keys per page, so multi-page listings get exercised. Set .down = true to answer 503.
 * (The signing itself is checked against AWS's published examples in test/s3.test.js.)
 */
const http = require('http');
const crypto = require('crypto');
const { sign, sha256 } = require('../../lib/s3');

async function startFakeS3({ bucket = 'ko-test', accessKey = 'TESTKEY', secretKey = 'testsecret', region = 'us-east-1' } = {}) {
  const objects = new Map(), log = [];
  const xmlErr = (res, status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks), url = new URL(req.url, 'http://x');
    log.push(`${req.method} ${url.pathname}${url.search}`);
    if (fake.down) return xmlErr(res, 503, 'SlowDown');
    // Check the signature against what was actually sent.
    const auth = String(req.headers.authorization || ''), m = auth.match(/Credential=([^/]+)\/[^,]+,SignedHeaders=([^,]+),Signature=([0-9a-f]+)/);
    if (!m) return xmlErr(res, 403, 'AccessDenied');
    if (m[1] !== accessKey) return xmlErr(res, 403, 'InvalidAccessKeyId');
    const declared = req.headers['x-amz-content-sha256'];
    if (declared !== 'UNSIGNED-PAYLOAD' && declared !== sha256(body)) return xmlErr(res, 400, 'XAmzContentSHA256Mismatch');
    const headers = Object.fromEntries(m[2].split(';').map(h => [h, req.headers[h]]));
    const path = decodeURIComponent(url.pathname);   // sign() encodes it again, segment by segment
    const query = Object.fromEntries(url.searchParams);
    const expected = sign({ method: req.method, path, query, headers, payloadHash: declared, accessKey, secretKey, region }).signature;
    if (expected !== m[3]) return xmlErr(res, 403, 'SignatureDoesNotMatch');
    const [, b, ...rest] = path.split('/'), key = rest.join('/');
    if (b !== bucket) return xmlErr(res, 404, 'NoSuchBucket');
    if (req.method === 'PUT' && key) { objects.set(key, body); res.writeHead(200); return res.end(); }
    if (req.method === 'GET' && key) { if (!objects.has(key)) return xmlErr(res, 404, 'NoSuchKey'); res.writeHead(200); return res.end(objects.get(key)); }
    if (req.method === 'DELETE' && key) { objects.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && !key && query['list-type'] === '2') {
      const all = [...objects.keys()].filter(k => k.startsWith(query.prefix || '')).sort();
      const start = Number(query['continuation-token'] || 0), page = all.slice(start, start + 2), more = start + 2 < all.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><ListBucketResult>${page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    xmlErr(res, 400, 'NotImplemented');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const fake = {
    objects, log, down: false, bucket,
    env: { STORAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}`, STORAGE_REGION: region, STORAGE_BUCKET: bucket, STORAGE_KEY: accessKey, STORAGE_SECRET: secretKey },
    keys: prefix => [...objects.keys()].filter(k => k.startsWith(prefix || '')).sort(),
    stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
  return fake;
}
module.exports = { startFakeS3 };
