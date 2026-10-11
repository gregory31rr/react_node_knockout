/**
 * lib/recordings.js — where call recordings are kept.
 *
 * Without settings: in the database (table recordings), as before. Fine for a demo or one small team.
 * For production: S3-compatible file storage (DigitalOcean Spaces), so recordings don't bloat the database
 * and its backups. Set all of:
 *   STORAGE_ENDPOINT=https://nyc3.digitaloceanspaces.com   STORAGE_REGION=nyc3   STORAGE_BUCKET=knockout-recordings
 *   STORAGE_KEY=…   STORAGE_SECRET=…       (optional: STORAGE_PATH_STYLE=0 to use bucket.endpoint addresses)
 *
 * Either way every recording is encrypted by Knockout before it's stored (lib/util.js encryptBuffer), so the
 * storage company only ever holds scrambled data. Each workspace's files live under recordings/ws<id>/, so
 * deleting a workspace can remove every one of its files, including any left over from a failed step.
 * Recordings saved in the database before storage was switched on keep playing.
 */
const crypto = require('crypto');
const { one, run, tx } = require('./db');
const U = require('./util');
const { S3 } = require('./s3');

let s3 = null;
function storage() {
  if (s3 !== null) return s3 || null;
  const e = process.env;
  s3 = e.STORAGE_ENDPOINT ? new S3({ endpoint: e.STORAGE_ENDPOINT, region: e.STORAGE_REGION, bucket: e.STORAGE_BUCKET, accessKey: e.STORAGE_KEY, secretKey: e.STORAGE_SECRET, pathStyle: e.STORAGE_PATH_STYLE !== '0' }) : false;
  return s3 || null;
}
const where = () => storage() ? 'file storage' : 'database';
const folder = wsId => `recordings/ws${Number(wsId)}/`;

/** Save (or replace) a call's recording. On failure nothing changes: the old recording, if any, stays. */
async function save(meetingId, wsId, audio, type) {
  const sealed = U.encryptBuffer(audio), st = storage();
  if (!st) {
    await tx(async () => {
      await run('DELETE FROM recordings WHERE meeting_id=?', meetingId);
      await run('INSERT INTO recordings(meeting_id,workspace_id,data,type,bytes) VALUES(?,?,?,?,?)', meetingId, wsId, sealed, type, audio.length);
    });
    return;
  }
  // New file first, under a new name; then point the call at it; then remove the old file.
  const key = `${folder(wsId)}call${Number(meetingId)}-${crypto.randomBytes(8).toString('hex')}.bin`;
  await st.put(key, sealed);
  const old = await one('SELECT object_key FROM recordings WHERE meeting_id=?', meetingId);
  try {
    await tx(async () => {
      await run('DELETE FROM recordings WHERE meeting_id=?', meetingId);
      await run('INSERT INTO recordings(meeting_id,workspace_id,data,type,bytes,object_key) VALUES(?,?,?,?,?,?)', meetingId, wsId, Buffer.alloc(0), type, audio.length, key);
    });
  } catch (e) { await st.del(key).catch(() => { }); throw e; }
  if (old?.object_key) await st.del(old.object_key).catch(e => console.warn('recordings: could not remove a replaced file (removed with its workspace later):', e.message));
}

/** The recording's audio, or null. */
async function load(meetingId) {
  const r = await one('SELECT data, object_key FROM recordings WHERE meeting_id=?', meetingId); if (!r) return null;
  if (!r.object_key) return U.decryptBuffer(Buffer.from(r.data));   // kept in the database (also older ones)
  const st = storage(); if (!st) throw new Error('This recording is in file storage, but file storage is not set up (STORAGE_ENDPOINT).');
  const sealed = await st.get(r.object_key);
  return sealed ? U.decryptBuffer(sealed) : null;
}

/** Remove a call's recording. The file goes first, so a failure leaves everything as it was. */
async function remove(meetingId) {
  const r = await one('SELECT object_key FROM recordings WHERE meeting_id=?', meetingId);
  if (r?.object_key) { const st = storage(); if (st) await st.del(r.object_key); }
  await run('DELETE FROM recordings WHERE meeting_id=?', meetingId);
}

/** Before a workspace is deleted: remove every one of its files. Throws (and nothing is deleted) if storage can't be reached. */
async function eraseWorkspace(wsId) {
  const st = storage(); if (!st) return 0;
  const keys = await st.list(folder(wsId));
  for (const k of keys) await st.del(k);
  return keys.length;
}

module.exports = { save, load, remove, eraseWorkspace, where, _reset: () => { s3 = null; } };
