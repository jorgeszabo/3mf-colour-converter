'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../converter');
const W = require('../workflow.cjs');
const data = require('../indx-profiles');
const printer = () => ({ project3: structuredClone(data.group), format: 3, extruders: 8 });
const tetra = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1" paint_color="4"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh>';
const xml = (unit = 'millimeter', items = '<item objectid="1"/>') => `<model unit="${unit}"><resources><object id="1" name="tetra">${tetra}</object></resources><build>${items}</build></model>`;
async function load(text = xml(), extra = []) {
  const zip = await C.writeZip([{ name: '3D/3dmodel.model', parts: [text] }, ...extra]);
  return C.load3mf(new Uint8Array(await zip.arrayBuffer()));
}
async function reload(model, target = 'prusa', opts = { printer: printer() }, map = []) {
  const zip = await C.convert(model, target, map, null, opts);
  return C.load3mf(new Uint8Array(await zip.arrayBuffer()));
}

test('normalizes non-mm vertices, component translations and build translations', async () => {
  const m = await load('<model unit="inch"><resources><object id="1">' + tetra + '</object><object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></build></model>');
  assert.equal(m.objects[0].volumes[0].vertices[0], 25.4);
  assert.equal(m.objects[0].volumes[0].vertices[3], 50.8);
  assert.equal(m.objects[0].instances[0][9], 50.8);
  const n = await reload(m, 'prusa', {});
  assert.equal(Math.max(...n.objects[0].volumes[0].vertices), 50.8);
});

test('handles production submodels with their own units', async () => {
  const root = '<model unit="millimeter"><resources><object id="2"><components><component objectid="1" p:path="/3D/part.model" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object></resources><build><item objectid="2"/></build></model>';
  const m = await load(root, [{ name: '3D/part.model', parts: [xml('inch')] }]);
  assert.equal(m.objects[0].volumes[0].vertices[3], 35.4);
});

for (const unit of ['micron', 'millimeter', 'centimeter', 'meter', 'inch', 'foot']) test('accepts 3MF unit ' + unit, async () => { assert.ok((await load(xml(unit))).objects.length); });
test('rejects unrecognized units', async () => { await assert.rejects(load(xml('yard')), /Unsupported/); });

for (const [label, target, opts] of [['Prusa3', 'prusa', { printer: printer() }], ['Prusa2', 'prusa', {}], ['Bambu', 'bambu', {}]]) {
  test(label + ' preserves disabled instances and leaves colour painting intact', async () => {
    const m = await load(xml('millimeter', '<item objectid="1" printable="0"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>'));
    const n = await reload(m, target, opts);
    assert.deepEqual(n.objects.flatMap((o) => o.instancePrintable), [false, true]);
    assert.equal(C.usage(n).paintedTriangles, C.usage(m).paintedTriangles * (target === 'bambu' ? 2 : 1));
  });
}

test('remaps paint to tool 8 without losing its tree', async () => {
  const n = await reload(await load(), 'prusa', { printer: printer() }, [0, 8]);
  assert.deepEqual([...C.usage(n).filaments.keys()], [8]);
  const states = []; C.walkPaint(n.objects[0].volumes[0].paint.color[0], null, (s) => states.push(s));
  assert.deepEqual(states, [8]);
});

test('reads native alpha13 disabled-instance metadata when XML flags are absent', async () => {
  const m = await load(xml('millimeter', '<item objectid="1"/><item objectid="1" printable="0" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>'));
  const blob = await C.convert(m, 'prusa', [], null, { printer: printer() });
  const zip = await C.readZip(new Uint8Array(await blob.arrayBuffer()));
  const project = JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text());
  assert.deepEqual(project.objects[0].instances, [{ ord: 1, printable: false }]);
  const files = [];
  for (const e of zip.entries.values()) files.push({ name: e.name, parts: [e.name === '3D/3dmodel.model' ? (await e.text()).replace(/ printable="[01]"/g, '') : await e.bytes()] });
  const nativeStyle = await C.writeZip(files);
  const reloaded = await C.load3mf(new Uint8Array(await nativeStyle.arrayBuffer()));
  assert.deepEqual(reloaded.objects[0].instancePrintable, [true, false]);
});

test('refuses implicit colour merges and out-of-range tools', async () => {
  const m = await load(); m.objects[0].extruder = 2;
  await assert.rejects(reload(m, 'prusa', { printer: printer() }, [0, 1, 1]), /merg/);
  await assert.rejects(reload(m, 'prusa', { printer: printer() }, [0, 9, 2]), /Invalid target/);
  await reload(m, 'prusa', { printer: printer(), allowColorMerge: true }, [0, 1, 1]);
});

test('Bambu multi-plate files require selection and retain only selected instances', async () => {
  const settings = '<config><plate><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate><plate><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/></model_instance></plate></config>';
  const m = await load(xml('millimeter', '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 300 0 0"/>'), [{ name: 'Metadata/model_settings.config', parts: [settings] }]);
  await assert.rejects(reload(m), /multiple beds/);
  const selected = C.selectBed(m, 2);
  assert.equal(selected.objects[0].instances.length, 1);
  assert.equal(selected.objects[0].instances[0][9], 300);
  await reload(selected);
});

test('Prusa multi-bed selection uses source bed origins and rejects ambiguous membership', async () => {
  const m = await load(xml('millimeter', '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 300 0"/>'));
  m.beds = [{ x: 0, y: 0, groupIndex: 0, shape: [[0, 0], [100, 100]] }, { x: 0, y: 300, groupIndex: 1, shape: [[0, 0], [100, 100]] }];
  const n = C.selectBed(m, 2);
  assert.equal(n.objects[0].instances.length, 1);
  assert.equal(n.objects[0].instances[0][10], 0);
  m.beds[1].y = 0;
  assert.throws(() => C.selectBed(m, 1), /unambiguously/);
});

test('current alpha14 hardware and every current material can be written coherently', async () => {
  assert.equal(data.slicerVersion, '3.0.0-alpha14');
  W.assertHardware(data.group);
  const m = await load(); m.filaments = [{ color: '#AABBCC', type: 'PETG', name: '' }];
  for (const [name, profile] of Object.entries(data.materials)) {
    const p = W.plan(m, data, { material: name });
    const b = await C.convert(m, 'prusa', p.map, null, { printer: p.printer });
    const z = await C.readZip(new Uint8Array(await b.arrayBuffer()));
    const g = JSON.parse(await z.get('Metadata/PrusaSlicer3_project.json').text()).config_containers[0];
    W.assertHardware(g);
    assert.equal(g.configuration.filament_settings.filament_type[0], profile.type);
    assert.equal(g.configuration.filament_settings.temperature[0], profile.filament.temperature);
    assert.equal(g.preset.hw_config.tools[0].slicer_material.type, profile.type);
  }
});

test('browser saved-printer defaults choose Generic PLA rather than PLA Silk', () => {
  const window = { INDX_PROFILES: structuredClone(data), PRUSA_PROFILES: [{ id: 'core1indx8t' }], PRUSA_FILAMENTS: { p3: {}, conditions: [] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'browser-indx.js'), 'utf8'), { window });
  assert.equal(window.PRUSA_PROFILES[0].materials3.PLA.material.root_id, 'Generic PLA');
  assert.equal(Object.keys(window.PRUSA_PROFILES[0].filaments3).length, Object.keys(data.materials).length);
});

test('plan preserves process choices and reports dropped overrides', async () => {
  const m = await load(); m.filaments = [{ color: '#AABBCC', type: 'PETG', name: '' }];
  m.sourceSettings = [{ scope: 'group 1/print_settings', values: { layer_height: 0.15, perimeters: 5, fill_density: { value: 40, is_percent: true } } }, { scope: 'object 1', values: { custom_speed: 7 } }];
  const p = W.plan(m, data);
  assert.equal(p.printer.project3.configuration.print_settings.layer_height, 0.15);
  assert.equal(p.printer.project3.configuration.print_settings.perimeters, 5);
  assert.deepEqual(p.printer.project3.configuration.toolprint_settings.perimeters, Array(8).fill(5));
  assert.equal(p.printer.profiles[0].type, 'PETG');
  assert.ok(p.report.settingsChanges.some((c) => c.key === 'custom_speed' && c.action === 'not transferred'));
  assert.deepEqual(p.report.target.activeTools, [1]);
});

test('0.15mm source selects real Detail presets and preserves process choices across PETG materials', async () => {
  const m = await load(); m.filaments = [{ color: '#AABBCC', type: 'PETG', name: '' }];
  m.sourceSettings = [
    { scope: 'group 1/print_settings', values: { layer_height: 0.15, perimeters: 5, fill_density: { value: 40, is_percent: true } } },
    { scope: 'group 1/toolprint_settings', values: { perimeters: Array(8).fill(5), fill_density: Array.from({ length: 8 }, () => ({ value: 40, is_percent: true })) } }
  ];
  const names = ['Generic PETG @', 'Prusament PETG @'].map((prefix) => Object.keys(data.materials).find((n) => n.startsWith(prefix)));
  assert.ok(names.every(Boolean));
  const projects = [];
  for (const material of names) {
    const p = W.plan(m, data, { material, config: { map: { 1: 3 } } });
    assert.equal(p.report.target.processPreset, '0.15mm');
    assert.equal(p.report.target.layerHeight, 0.15);
    assert.ok(p.printer.project3.preset.tools.every((t) => t.name.startsWith('0.15mm Detail')));
    assert.deepEqual(p.printer.project3.configuration.toolprint_settings.perimeters, Array(8).fill(5));
    const blob = await C.convert(m, 'prusa', p.map, null, { printer: p.printer });
    const zip = await C.readZip(new Uint8Array(await blob.arrayBuffer()));
    projects.push(JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text()).config_containers[0]);
  }
  for (const key of ['print_settings', 'toolprint_settings']) {
    assert.deepEqual(projects[0].configuration[key], projects[1].configuration[key]);
  }
  assert.equal(projects[0].preset.print.name, '0.15mm');
  assert.equal(projects[1].preset.materials[2].root_id, 'Prusament PETG');
  assert.deepEqual(W.plan(m, data, { targetProcess: true }).report.target.processPreset, '0.20mm');
});

test('explicit native process and paint depth apply before the first slice', async () => {
  const m = await load();
  m.filaments = [{ color: '#AABBCC', type: 'PLA', name: '' }];
  m.sourceSettings = [{ scope: 'group 1/print_settings', values: { layer_height: 0.2 } }];
  const config = { process: '0.15mm', map: { 1: 4 }, segmentedRegionMaxWidth: 1.5, infillTool: 4 };
  const p = W.plan(m, data, { config });
  assert.equal(p.report.target.layerHeight, 0.15);
  const c = p.printer.project3.configuration.print_settings;
  assert.equal(c.mmu_segmented_region_max_width, 1.5);
  assert.equal(c.infill_extruder, 4);
  const blob = await C.convert(m, 'prusa', p.map, null, { printer: p.printer });
  const zip = await C.readZip(new Uint8Array(await blob.arrayBuffer()));
  const g = JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text()).config_containers[0];
  assert.equal(g.configuration.print_settings.layer_height, 0.15);
  assert.equal(g.configuration.print_settings.infill_extruder, 4);
  for (const bad of [{ process: 'unknown' }, { segmentedRegionMaxWidth: -1 }, { infillTool: 8 }]) {
    assert.throws(() => W.plan(m, data, { config: bad }));
  }
});

test('reserved PETG interface material is retained without painting the model with it', async () => {
  const m = await load();
  m.filaments = [{ color: '#AABBCC', type: 'PLA', name: '' }];
  const petg = Object.keys(data.materials).find((n) => n.startsWith('Generic PETG @'));
  const config = { map: { 1: 4 }, materials: { 8: petg }, colors: { 8: '#E5ECEF' } };
  const p = W.plan(m, data, { config });
  assert.deepEqual(p.report.target.activeTools, [4]);
  const blob = await C.convert(m, 'prusa', p.map, null, { printer: p.printer });
  const zip = await C.readZip(new Uint8Array(await blob.arrayBuffer()));
  const g = JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text()).config_containers[0];
  assert.equal(g.preset.materials[7].name, petg);
  assert.equal(g.configuration.filament_settings.filament_type[7], 'PETG');
  assert.throws(() => W.plan(m, data, { config: { materials: { 8: 'Unknown PETG' } } }));
});

test('validation rejects a slicer exit-zero no-output failure, even with stale G-code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-test-'));
  try {
    const b = await C.convert(await load(), 'prusa', [], null, { printer: printer() });
    const file = path.join(dir, 'input.3mf'); fs.writeFileSync(file, Buffer.from(await b.arrayBuffer()));
    const fake = path.join(dir, 'fake-slicer');
    fs.writeFileSync(fake, '#!' + process.execPath + '\nconst fs=require("fs"),a=process.argv.slice(2);if(a.includes("--version"))console.error("3.0.0-alpha13");else if(a.includes("--export-3mf"))fs.copyFileSync(a.at(-1),a[a.indexOf("--output")+1]);else console.log("All objects are outside of the print volume.");\n', { mode: 0o755 });
    const dest = path.join(dir, 'validation'); fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'sliced.gcode'), 'stale');
    await assert.rejects(W.validate(file, fake, dest), /no valid G-code/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
