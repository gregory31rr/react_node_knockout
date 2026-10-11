/**
 * lib/s3.js — a small client for S3-compatible file storage (DigitalOcean Spaces, AWS S3, MinIO, …),
 * using only Node's built-in modules. Requests are signed with AWS Signature Version 4; the signing is
 * checked against AWS's own published examples in test/s3.test.js.
 *
 *   const s3 = new S3({ endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'nyc3', bucket: 'knockout',
 *                       accessKey: '…', secretKey: '…' })
 *   await s3.put('recordings/ws1/call7.bin', buffer, 'application/octet-stream')
 *   await s3.get('recordings/ws1/call7.bin')     → Buffer, or null if there's no such file
 *   await s3.del('recordings/ws1/call7.bin')     (no error if it was already gone)
 *   await s3.list('recordings/ws1/')             → every key under that folder
 */
const crypto = require('crypto');

const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
/** RFC 3986 encoding, as Signature V4 requires (encodeURIComponent leaves !'()* alone). */
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const EMPTY_HASH = sha256('');

/**
 * Signature Version 4. Returns the Authorization header value (and the steps, for tests).
 * path: the raw path ('/bucket/key'), encoded here segment by segment. query: { name: value }.
 * headers: lowercase names → values; must include host, x-amz-date and x-amz-content-sha256.
 */
function sign({ method, path, query = {}, headers, payloadHash, accessKey, secretKey, region, service = 's3' }) {
  const amzDate = headers['x-amz-date'], day = amzDate.slice(0, 8);
  const canonicalUri = path.split('/').map(enc).join('/') || '/';
  const canonicalQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k] ?? '')}`).join('&');
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = names.map(h => `${h}:${String(headers[h]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`, canonicalRequest, stringToSign, signature };
}

class S3Error extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }

class S3 {
  /** pathStyle: address files as endpoint/bucket/key (works everywhere); otherwise bucket.endpoint/key. */
  constructor({ endpoint, region, bucket, accessKey, secretKey, pathStyle = true, timeoutMs = 60000 }) {
    if (!endpoint || !bucket || !accessKey || !secretKey) throw new Error('File storage needs an endpoint, bucket, access key and secret key.');
    this.url = new URL(endpoint); this.region = region || 'us-east-1'; this.bucket = bucket;
    this.accessKey = accessKey; this.secretKey = secretKey; this.pathStyle = pathStyle; this.timeoutMs = timeoutMs;
  }
  async request(method, key, { body, query = {}, contentType } = {}) {
    const host = this.pathStyle ? this.url.host : `${this.bucket}.${this.url.host}`;
    const path = (this.pathStyle ? `/${this.bucket}` : '') + (key ? '/' + key : '/');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = body ? sha256(body) : EMPTY_HASH;
    const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    if (contentType) headers['content-type'] = contentType;
    const { authorization } = sign({ method, path, query, headers, payloadHash, accessKey: this.accessKey, secretKey: this.secretKey, region: this.region });
    const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k] ?? '')}`).join('&');
    const url = `${this.url.protocol}//${host}${path.split('/').map(enc).join('/')}${qs ? '?' + qs : ''}`;
    const send = { ...headers }; delete send.host;
    let res;
    try { res = await fetch(url, { method, headers: { ...send, authorization }, body, signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch (e) { throw new S3Error(`File storage could not be reached (${e.cause?.code || e.name}).`, 0, 'Unreachable'); }
    return res;
  }
  async fail(res, what) {
    const text = await res.text().catch(() => ''), code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || String(res.status);
    const hint = { SignatureDoesNotMatch: ' Check the storage secret key.', InvalidAccessKeyId: ' Check the storage access key.', NoSuchBucket: ' Check the bucket name.', AccessDenied: ' Check the key has access to this bucket.' }[code] || '';
    throw new S3Error(`File storage refused to ${what} (${code}).${hint}`, res.status, code);
  }
  async put(key, body, contentType = 'application/octet-stream') {
    const res = await this.request('PUT', key, { body, contentType });
    if (!res.ok) await this.fail(res, 'save the file'); await res.arrayBuffer();
  }
  async get(key) {
    const res = await this.request('GET', key);
    if (res.status === 404) { await res.arrayBuffer(); return null; }
    if (!res.ok) await this.fail(res, 'send the file');
    return Buffer.from(await res.arrayBuffer());
  }
  async del(key) {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) await this.fail(res, 'delete the file'); await res.arrayBuffer().catch(() => { });
  }
  /** Every key starting with prefix (follows the pages of a long listing). */
  async list(prefix) {
    const keys = []; let token = null;
    do {
      const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const res = await this.request('GET', '', { query });
      if (!res.ok) await this.fail(res, 'list files');
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml((xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] || '') : null;
    } while (token);
    return keys;
  }
}
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

module.exports = { S3, S3Error, sign, sha256 };
