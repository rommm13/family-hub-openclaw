import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openFamilyDb, bootstrapFamily } from "../dist/db.js";
import { setupExtras, photoUpload } from "../miniapp/extras.mjs";

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-photo-exif-"));
  const db = openFamilyDb(path.join(dir, "family.sqlite"));
  bootstrapFamily(db, {
    household: { id: "home", name: "Home" },
    members: [{ id: "member-a", name: "Member A", role: "parent" }],
    bindings: [{ runtimeId: "family-agent", agentId: "main", memberId: "member-a" }],
  });
  setupExtras(db);
  // create a place the member can attach photos to
  db.prepare("INSERT INTO places(id,household_id,name,created_by) VALUES(?,?,?,?)").run("p1", "home", "Test place", "member-a");
  const member = { id: "member-a", name: "Member A", role: "parent", householdId: "home" };
  return { dir, db, member, imageDir: path.join(dir, "photos") };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function seg(marker, payload) { return Buffer.concat([Buffer.from([0xff, marker & 0xff]), u16(payload.length + 2), payload]); }

// Minimal baseline JPEG: 1x1, 1 component, quality-ish tables, single MCU.
function minimalJpegBody() {
  const dqt = seg(0xdb, Buffer.from([
    0x00, // precision 0, table 0
    ...Array(64).fill(16),
  ]));
  const sof0 = seg(0xc0, Buffer.from([
    0x08, // precision
    0x00,0x01, // height
    0x00,0x01, // width
    0x01, // components
    0x01,0x11,0x00, // id, sampling, qt
  ]));
  const dht = seg(0xc4, Buffer.concat([
    Buffer.from([0x00]), // DC table 0
    Buffer.from(Array(16).fill(0)),
    Buffer.from([0x00]),
  ]));
  const sos = Buffer.concat([
    Buffer.from([0xff,0xda]),
    u16(8),
    Buffer.from([0x01,0x01,0x00,0x00,0x3f,0x00]),
    Buffer.from([0xff,0x00,0xff,0xd9]), // minimal scan + EOI
  ]);
  return Buffer.concat([dqt, sof0, dht, sos]);
}

function jpegWithGpsExif() {
  // APP1 payload: "Exif\0\0" + fake TIFF-like bytes containing GPS tags/coords.
  // The sanitizer strips APP1 by marker; GPS bytes must not survive in saved file.
  const gpsNeedle = Buffer.from("GPSLatitudeRef\x00N\x00GPSLatitude-SYNTHETIC;GPSLongitude-SYNTHETIC", "latin1");
  const exifPayload = Buffer.concat([
    Buffer.from("Exif\x00\x00", "latin1"),
    Buffer.from([0x49,0x49,0x2a,0x00,0x08,0x00,0x00,0x00]), // TIFF little-endian header
    gpsNeedle,
    Buffer.alloc(16, 0),
  ]);
  return Buffer.concat([
    Buffer.from([0xff,0xd8]), // SOI
    seg(0xe1, exifPayload),   // APP1 EXIF/GPS
    seg(0xfe, Buffer.from("phone=secret", "utf8")), // COM metadata
    minimalJpegBody(),
  ]);
}

test("photoUpload strips JPEG EXIF/GPS metadata from saved file (regression)", () => {
  const { dir, db, member, imageDir } = tempEnv();
  try {
    const original = jpegWithGpsExif();
    assert.match(original.toString("latin1"), /Exif/);
    assert.match(original.toString("latin1"), /GPSLatitude/);

    const data = original.toString("base64");
    const result = photoUpload(db, member, { section: "places", entityId: "p1", mime: "image/jpeg", data }, imageDir);
    assert.equal(result.mime, "image/jpeg");

    const row = db.prepare("SELECT file_name AS fileName FROM miniapp_photos WHERE id=?").get(result.id);
    const saved = fs.readFileSync(path.join(imageDir, row.fileName));
    const text = saved.toString("latin1");

    assert.equal(saved[0], 0xff);
    assert.equal(saved[1], 0xd8);
    assert.doesNotMatch(text, /Exif\0\0/);
    assert.doesNotMatch(text, /GPSLatitude/);
    assert.doesNotMatch(text, /GPSLongitude/);
    assert.doesNotMatch(text, /phone=secret/); // COM stripped
    assert.match(text, /\xff\xd9/); // still a JPEG with EOI
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("photoUpload rejects images with excessive decoded dimensions", () => {
  const { dir, db, member, imageDir } = tempEnv();
  try {
    // JPEG SOF0 declaring 20000x3000 = 60,000,000 pixels (> 40MP limit)
    const sof0 = seg(0xc0, Buffer.from([
      0x08,
      0x0b,0xb8, // height 3000
      0x4e,0x20, // width 20000
      0x01, 0x01,0x11,0x00,
    ]));
    const big = Buffer.concat([
      Buffer.from([0xff,0xd8]),
      seg(0xdb, Buffer.from([0x00, ...Array(64).fill(16)])),
      sof0,
      seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from(Array(16).fill(0)), Buffer.from([0x00])])),
      Buffer.concat([Buffer.from([0xff,0xda]), u16(8), Buffer.from([0x01,0x01,0x00,0x00,0x3f,0x00]), Buffer.from([0xff,0x00,0xff,0xd9])]),
    ]);
    assert.throws(
      () => photoUpload(db, member, { section: "places", entityId: "p1", mime: "image/jpeg", data: big.toString("base64") }, imageDir),
      /too many pixels|dimensions too large/
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("photoUpload enforces total storage quota before saving second file (regression)", () => {
  const { dir, db, member, imageDir } = tempEnv();
  try {
    const first = photoUpload(db, member, { section: "places", entityId: "p1", mime: "image/jpeg", data: jpegWithGpsExif().toString("base64") }, imageDir);
    const firstRow = db.prepare("SELECT file_name AS fileName FROM miniapp_photos WHERE id=?").get(first.id);
    const firstSize = fs.statSync(path.join(imageDir, firstRow.fileName)).size;
    assert.ok(firstSize > 0);
    fs.mkdirSync(imageDir, { recursive: true });
    const filesBefore = fs.readdirSync(imageDir).sort();

    // Create a second valid place (max 6 per entity); quota allows only the first stored file.
    db.prepare("INSERT INTO places(id,household_id,name,created_by) VALUES(?,?,?,?)").run("p2", "home", "Test place 2", "member-a");
    assert.throws(
      () => photoUpload(db, member, { section: "places", entityId: "p2", mime: "image/jpeg", data: jpegWithGpsExif().toString("base64") }, imageDir, firstSize + 1),
      /quota exceeded/i
    );

    const filesAfter = fs.readdirSync(imageDir).sort();
    assert.deepEqual(filesAfter, filesBefore, "quota refusal must happen before creating second file");
    const count = db.prepare("SELECT COUNT(*) AS n FROM miniapp_photos").get().n;
    assert.equal(count, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
