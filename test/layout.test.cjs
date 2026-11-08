'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('../converter');
const L = require('../layout.cjs');
const data = require('../indx-profiles');

async function fixture(dir, name, tool = 1, { painted = false, disabled = false } = {}) {
  const bed = path.join(dir, 'bed.stl');
  fs.writeFileSync(bed, 'solid bed\nfacet normal 0 0 1\nouter loop\nvertex -124 -102.5 0\nvertex 124 -102.5 0\nvertex 124 102.5 0\nendloop\nendfacet\nendsolid bed\n');
  const xml = `<model unit="millimeter"><resources><object id="1" name="${name}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const input = await C.writeZip([{ name: '3D/3dmodel.model', parts: [xml] }]);
  const model = await C.load3mf(new Uint8Array(await input.arrayBuffer()));
  model.objects[0].extruder = tool;
  if (painted) model.objects[0].volumes[0].paint.color = ['1C'];
  if (disabled) { model.objects[0].instances.push([1, 0, 0, 0, 1, 0, 0, 0, 1, 30, 0, 0]); model.objects[0].instancePrintable.push(false); }
  const blob = await C.convert(model, 'prusa', [], null, { printer: { project3: structuredClone(data.group), format: 3, extruders: 8 } });
  const zip = await C.readZip(new Uint8Array(await blob.arrayBuffer()));
  const project = JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text());
  project.config_containers[0].configuration.printer_settings.bed_custom_model = bed;
  project.objects[0].object_settings.layer_height = 0.12;
  const files = [];
  for (const entry of zip.entries.values()) files.push({ name: entry.name, parts: [entry.name === 'Metadata/PrusaSlicer3_project.json' ? JSON.stringify(project) : await entry.bytes()] });
  const result = await C.writeZip(files), file = path.join(dir, name + '.3mf');
  fs.writeFileSync(file, Buffer.from(await result.arrayBuffer()));
  return L.readProject(file);
}

function fakeSlicer(dir, mode = 'normal') {
  const file = path.join(dir, 'fake-' + mode);
  fs.writeFileSync(file, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), C = require(${JSON.stringify(path.join(__dirname, '..', 'converter.js'))});
(async () => {
  const args = process.argv.slice(2), out = args[args.indexOf('--output') + 1], input = args.at(-1);
  if (args.includes('--version')) { console.error('3.0.0-alpha13'); return; }
  if (args.includes('--export-3mf')) {
    if (!['corrupt', 'move'].includes(${JSON.stringify(mode)})) { fs.copyFileSync(input, out); return; }
    const z = await C.readZip(fs.readFileSync(input)), files = [];
    for (const e of z.entries.values()) {
      let b = await e.bytes();
      if (${JSON.stringify(mode)} === 'corrupt' && e.name === 'Metadata/PrusaSlicer3_project.json') { const p = JSON.parse(await e.text()); p.objects[0].object_settings.extruder = 7; b = JSON.stringify(p); }
      if (${JSON.stringify(mode)} === 'move' && e.name === '3D/3dmodel.model') b = (await e.text()).replace(/(<item[^>]*transform=")([^"]+)(")/, (_, a, value, c) => { const t = value.split(' ').map(Number); t[9] += 5; return a + t.join(' ') + c; });
      files.push({ name: e.name, parts: [b] });
    }
    fs.writeFileSync(out, Buffer.from(await (await C.writeZip(files)).arrayBuffer())); return;
  }
  const model = await C.load3mf(fs.readFileSync(input)), names = model.objects.map(o => o.name).sort().join(',');
  if (${JSON.stringify(mode)} === 'reject-merges' && model.objects.length > 1) { console.log('slicing failed'); return; }
  const seconds = { A: 100, B: 70, C: 60, 'A,B': 120, 'A,C': 300, 'B,C': 200, 'A,B,C': 500 }[names] || 100;
  fs.writeFileSync(out, 'G427\\n; estimated printing time (normal mode) = ' + seconds + 's\\n; total toolchanges = ' + (model.objects.length > 1 ? 20 : 0) + '\\n');
  console.log('Slicing result exported to ' + out);
})().catch(e => { console.error(e); process.exitCode = 1; });
`, { mode: 0o755 });
  return file;
}

const shape = [[0, 0], [100, 0], [100, 80], [0, 80]];
const item = (key, w, h) => ({ key, printable: true, bounds: [10, 12, 10 + w, 12 + h] });
test('packing is collision-free, retains every item and splits overflowing beds', () => {
  const bins = L.pack([item('a', 60, 60), item('b', 60, 60), item('c', 20, 20)], shape);
  assert.equal(bins.length, 2);
  assert.deepEqual(bins.flat().map((p) => p.item.key).sort(), ['a', 'b', 'c']);
  for (const bin of bins) for (const [i, p] of bin.entries()) {
    const a = p.item.bounds.map((v, n) => v + (n % 2 ? p.dy : p.dx));
    assert(a[0] >= 5 && a[1] >= 5 && a[2] <= 95 && a[3] <= 75);
    for (const q of bin.slice(i + 1)) {
      const b = q.item.bounds.map((v, n) => v + (n % 2 ? q.dy : q.dx));
      assert(a[2] + 5 <= b[0] || b[2] + 5 <= a[0] || a[3] + 5 <= b[1] || b[3] + 5 <= a[1]);
    }
  }
  assert.equal(L.pack([item('oversized', 101, 20)], shape), null);
});

test('native multi-bed writing preserves fine layers, painting, tool 8, and disabled instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const a = await fixture(dir, 'A', 8, { disabled: true }), b = await fixture(dir, 'B', 2, { painted: true });
    const ai = L.itemsFor(a, [1], 0), bi = L.itemsFor(b, [1], 1), file = path.join(dir, 'combined.3mf');
    await L.writeProject([a, b], [ai.map((item) => ({ item, dx: 0, dy: 0 })), bi.map((item) => ({ item, dx: 0, dy: 0 }))], file);
    const n = await L.readProject(file), items = L.itemsFor(n, [1, 2]);
    const declared = new Set();
    for (const [id, raw] of n.resources) {
      for (const ref of raw.matchAll(/objectid="(\d+)"/g)) assert.ok(declared.has(Number(ref[1])), 'Resource dependencies must precede their users for PrusaSlicer.');
      declared.add(id);
    }
    assert.equal(n.group.beds.length, 2);
    assert.deepEqual(items.map(L.signature).sort(), [...ai, ...bi].map(L.signature).sort());
    assert.equal(items.filter((i) => !i.printable).length, 1);
    assert.equal(n.model.objects[0].extruder, 8);
    assert.ok(n.project.objects.every((o) => o.object_settings.layer_height === 0.12));
    assert.ok(n.project.objects.every((o) => o.volumes.every((v) => !('extruder' in v.volume_settings))));
    assert.match(n.xml.slice(0, n.xml.indexOf('<resources')), /MmPaintingVersion/);
    assert.equal(L.itemsFor(n, [2]).length, 1);
    const validation = await L.validateProject(file, fakeSlicer(dir), path.join(dir, 'validation'));
    assert.equal(validation.beds.length, 2);
    assert.equal(validation.passed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('speed follows measured time; fewer-beds accepts a slower one-bed result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const docs = await Promise.all(['A', 'B', 'C'].map((n, i) => fixture(dir, n, i + 1)));
    const inputs = docs.map((d) => d.file), originals = inputs.map((f) => fs.readFileSync(f));
    const slicer = fakeSlicer(dir);
    const speed = await L.optimize(inputs, { mode: 'speed', output: path.join(dir, 'speed.3mf'), slicer });
    assert.equal(speed.selected.beds, 2);
    assert.equal(speed.selected.estimatedSeconds, 180);
    const fewer = await L.optimize(inputs, { mode: 'fewer-beds', output: path.join(dir, 'fewer.3mf'), slicer });
    assert.equal(fewer.selected.beds, 1);
    assert.equal(fewer.selected.estimatedSeconds, 500);
    assert.ok(speed.validation.passed && fewer.validation.passed);
    const resplit = await L.optimize([fewer.output], { mode: 'speed', beds: '1', output: path.join(dir, 'resplit.3mf'), slicer });
    assert.equal(resplit.selected.beds, 2);
    assert.equal(resplit.selected.estimatedSeconds, 180);
    for (let i = 0; i < inputs.length; i++) assert.deepEqual(fs.readFileSync(inputs[i]), originals[i]);
    await assert.rejects(L.optimize(inputs, { mode: 'speed', output: inputs[0], slicer }), /must be different/);
    await assert.rejects(L.optimize([speed.output], { mode: 'fewer-beds', output: path.join(dir, 'unselected.3mf'), slicer }), /Select source beds explicitly/);
    const selected = await L.optimize([speed.output], { mode: 'fewer-beds', beds: '1', output: path.join(dir, 'selected.3mf'), slicer });
    assert.equal(selected.validation.beds[0].objects.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed packed candidates fall back to valid beds, and native setting corruption prevents publishing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const docs = await Promise.all(['A', 'B'].map((n) => fixture(dir, n)));
    const output = path.join(dir, 'result.3mf'), inputs = docs.map((d) => d.file);
    const report = await L.optimize(inputs, { mode: 'fewer-beds', output, slicer: fakeSlicer(dir, 'reject-merges') });
    assert.equal(report.selected.beds, 2);
    assert.ok(report.candidates.some((c) => c.valid === false));
    const saved = fs.readFileSync(output);
    await assert.rejects(L.optimize(inputs, { mode: 'speed', output, force: true, slicer: fakeSlicer(dir, 'corrupt') }), /changed during native reopen/);
    assert.deepEqual(fs.readFileSync(output), saved);
    await assert.rejects(L.optimize(inputs, { mode: 'speed', output, force: true, slicer: fakeSlicer(dir, 'move') }), /placement changed during native reopen/);
    assert.deepEqual(fs.readFileSync(output), saved);
    const changed = structuredClone(docs[0].group); changed.configuration.print_settings.layer_height = 0.25;
    assert.equal(L.compatible(docs[0].group, changed), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normal-mode estimates handle hours/minutes/seconds and never default missing data to zero', () => {
  assert.deepEqual(L.estimate('; estimated printing time (normal mode) = 2h 0m 18s\n; total toolchanges = 215\n'), { seconds: 7218, display: '2h 0m 18s', toolChanges: 215 });
  assert.throws(() => L.estimate(''), /did not report/);
});

test('optimization does not merge parts that require different bed temperatures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const docs = await Promise.all(['A', 'B'].map((name, i) => fixture(dir, name, i + 1)));
    for (const doc of docs) {
      for (const key of ['bed_temperature', 'first_layer_bed_temperature']) {
        doc.project.config_containers[0].configuration.filament_settings[key][0] = 60;
        doc.project.config_containers[0].configuration.filament_settings[key][1] = 70;
      }
      const entries = [];
      for (const e of doc.zip.entries.values()) entries.push({ name: e.name, parts: [e.name === 'Metadata/PrusaSlicer3_project.json' ? JSON.stringify(doc.project) : await e.bytes()] });
      fs.writeFileSync(doc.file, Buffer.from(await (await C.writeZip(entries)).arrayBuffer()));
    }
    const report = await L.optimize(docs.map((d) => d.file), { mode: 'fewer-beds', output: path.join(dir, 'result.3mf'), slicer: fakeSlicer(dir) });
    assert.equal(report.selected.beds, 2);
    assert.equal(report.selected.estimatedSeconds, 170);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('combined validation rejects an exit-zero native export with a stale saved project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const doc = await fixture(dir, 'A'), dest = path.join(dir, 'validation');
    fs.mkdirSync(dest); fs.copyFileSync(doc.file, path.join(dest, 'reopened.3mf'));
    const fake = path.join(dir, 'no-output'); fs.writeFileSync(fake, '#!' + process.execPath + '\n', { mode: 0o755 });
    await assert.rejects(L.validateProject(doc.file, fake, dest), /did not save/);
    const protectedFile = path.join(dir, 'reopened.3mf'); fs.copyFileSync(doc.file, protectedFile);
    await assert.rejects(L.validateProject(protectedFile, fake, dir), /must not overwrite/);
    assert.deepEqual(fs.readFileSync(protectedFile), fs.readFileSync(doc.file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('combined validation rejects edge-touching objects that a CLI slice can accept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const doc = await fixture(dir, 'A'), items = L.itemsFor(doc, [1]), file = path.join(dir, 'edge.3mf');
    await L.writeProject([doc], [items.map((item) => ({ item, dx: -item.bounds[0], dy: 0 }))], file);
    await assert.rejects(L.validateProject(file, fakeSlicer(dir), path.join(dir, 'check')), /touches a bed edge/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('display-frame offsets are shared by every bed and validation uses printable local coordinates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-layout-'));
  try {
    const doc = await fixture(dir, 'A');
    fs.writeFileSync(doc.group.configuration.printer_settings.bed_custom_model, 'solid frame\nfacet normal 0 0 1\nouter loop\nvertex -127 -133.5 0\nvertex 127 -133.5 0\nvertex 127 133.5 0\nendloop\nendfacet\nendsolid frame\n');
    assert.deepEqual(L.bedGeometry(doc.group), { x: 3, y: 31, step: 274 });
    const file = path.join(dir, 'offset.3mf'), items = L.itemsFor(doc, [1]);
    await L.writeProject([doc], [items.map((item) => ({ item, dx: 0, dy: 80 }))], file);
    const output = await L.readProject(file);
    assert.equal(output.group.beds[0].position_y, 31);
    assert.ok(C.instanceBounds(output.model.objects[0], output.model.objects[0].instances[0])[3] > 205);
    const result = await L.validateProject(file, fakeSlicer(dir), path.join(dir, 'check'));
    assert.equal(result.passed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
