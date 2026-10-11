/**
 * test/s3.test.js — lib/s3.js signing, checked against AWS's own published Signature V4 examples
 * (docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html). If these match, real S3-compatible
 * storage (DigitalOcean Spaces, AWS) accepts our requests.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sign, sha256 } = require('../lib/s3');

const C = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const base = { host: 'examplebucket.s3.amazonaws.com', 'x-amz-date': '20130524T000000Z' };

describe('Signature V4 matches AWS\'s published examples', () => {
  test('GET object with a Range header', () => {
    const r = sign({ ...C, method: 'GET', path: '/test.txt', headers: { ...base, range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY });
    assert.equal(r.stringToSign.split('\n')[3], '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.equal(r.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  test('PUT object (body hash, a $ in the name, extra headers)', () => {
    const body = 'Welcome to Amazon S3.', h = sha256(body);
    assert.equal(h, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const r = sign({ ...C, method: 'PUT', path: '/test$file.text', payloadHash: h,
      headers: { ...base, date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': h } });
    assert.match(r.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
    assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
  test('GET bucket lifecycle (a query name with no value)', () => {
    const r = sign({ ...C, method: 'GET', path: '/', query: { lifecycle: '' }, headers: { ...base, 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY });
    assert.equal(r.signature, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
  test('list objects (two query values, sorted)', () => {
    const r = sign({ ...C, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, headers: { ...base, 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY });
    assert.equal(r.stringToSign.split('\n')[3], 'df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7');
    assert.equal(r.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});
