'use strict';
// Layout native, already-configured INDX projects without reconverting their settings.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const C = require('./converter');
const W = require('./workflow.cjs');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const stableJSON = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
function normalizedPreset(group) {
  const preset = structuredClone(group.preset);
  delete preset.hw_config.config_id;
  delete preset.printer.id;
  return preset;
}

async function readProject(file) {
  const bytes = fs.readFileSync(file), zip = await C.readZip(bytes);
  const entry = zip.get('Metadata/PrusaSlicer3_project.json');
  if (!entry) throw new Error('Optimize needs native PrusaSlicer 3 INDX projects. Convert each selected Bambu/Orca bed first.');
  const project = JSON.parse(await entry.text());
  if (project.config_containers.length !== 1) throw new Error('Optimize currently supports one printer group per input project.');
  const group = project.config_containers[0];
  W.assertHardware(group);
  if (group.configuration.print_settings.complete_objects) throw new Error('Sequential printing requires manual clearance review; optimize supports printing by layer.');
  if (group.configuration.print_settings.wipe_tower) throw new Error('Wipe towers require manual layout review before optimization.');
  // Do not silently discard metadata whose object references we cannot remap.
  for (const entry of zip.entries.values()) {
    if (!/^(?:\[Content_Types\]\.xml|_rels\/\.rels|3D\/3dmodel\.model|Metadata\/(?:PrusaSlicer3_project\.json|Slic3r_facets_annotation\.json|thumbnail[^/]*\.(?:png|jpg)))$/i.test(entry.name)) {
      throw new Error('Optimize cannot safely remap this project attachment: ' + entry.name);
    }
  }
  const xml = await zip.get('3D/3dmodel.model').text();
  const resources = new Map([...xml.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>[\s\S]*?<\/object>/g)].map((m) => [Number(m[1]), m[0]]));
  const model = await C.load3mf(bytes);
  if (model.badPaint) throw new Error('Repair invalid source paint before optimizing.');
  const builds = [...xml.slice(xml.indexOf('<build')).matchAll(/<item\b[^>]*\/?>/g)].map((m) => m[0]);
  const facets = zip.get('Metadata/Slic3r_facets_annotation.json');
  return { file, bytes, zip, xml, resources, builds, project, group, model, facets: facets ? JSON.parse(await facets.text()) : [] };
}

function compatible(a, b) {
  return isDeepStrictEqual(a.configuration, b.configuration) && isDeepStrictEqual(normalizedPreset(a), normalizedPreset(b));
}

function resolveBedModel(group, slicer) {
  const ps = group.configuration.printer_settings, h = group.preset.hw_config;
  if (ps.bed_custom_model && fs.existsSync(ps.bed_custom_model)) return ps.bed_custom_model;
  const packaged = path.resolve(path.dirname(slicer), '..', 'Resources', 'presets', h.repo_id, h.vendor_id, 'assets', h.bed_model);
  if (!fs.existsSync(packaged)) throw new Error('Cannot locate the installed bed display mesh. Set bed_custom_model to its existing STL before optimizing.');
  ps.bed_custom_model = packaged;
  return packaged;
}

function bedGeometry(group) {
  const ps = group.configuration.printer_settings, file = ps.bed_custom_model;
  if (!file || !fs.existsSync(file)) throw new Error('A resolved bed display mesh is required for consistent GUI/CLI bed coordinates.');
  const bytes = fs.readFileSync(file), bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function vertex(x, y) { bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); }
  const count = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  if (count && 84 + count * 50 === bytes.length) {
    for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) { const p = 84 + i * 50 + 12 + j * 12; vertex(bytes.readFloatLE(p), bytes.readFloatLE(p + 4)); }
  } else for (const m of bytes.toString('utf8').matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)) vertex(Number(m[1]), Number(m[2]));
  if (!bounds.every(Number.isFinite)) throw new Error('Invalid bed display STL: ' + file);
  const shape = ps.bed_shape, loX = Math.min(...shape.map((p) => p[0])), hiX = Math.max(...shape.map((p) => p[0])), loY = Math.min(...shape.map((p) => p[1])), hiY = Math.max(...shape.map((p) => p[1]));
  // alpha13 centres the display STL on the printable shape, then arranges its full frame.
  const minX = Math.min(loX, bounds[0] + (loX + hiX) / 2), minY = Math.min(loY, bounds[1] + (loY + hiY) / 2);
  const maxX = Math.max(hiX, bounds[2] + (loX + hiX) / 2);
  return { x: -minX, y: -minY, step: maxX - minX + 20 };
}

function itemsFor(doc, beds, docIndex = 0) {
  const items = [];
  const shape = doc.group.configuration.printer_settings.bed_shape;
  const objects = new Map(doc.model.objects.map((o) => [Number(o.sourceId), o]));
  const instanceCount = new Map();
  doc.builds.forEach((raw, ordinal) => {
    const id = Number(/\bobjectid="(\d+)"/.exec(raw)?.[1]);
    const object = objects.get(id);
    if (!object) throw new Error('Unsupported native instance wrapper at build item ' + ordinal);
    const instance = instanceCount.get(id) || 0;
    instanceCount.set(id, instance + 1);
    const transform = object.instances[instance].slice();
    const bounds = C.instanceBounds({ ...object, volumes: object.volumes.map((v) => ({ ...v, type: 'part' })) }, transform);
    const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
    const hits = doc.group.beds.map((b, i) => ({ ...b, number: i + 1 })).filter((b) => cx >= b.position_x + Math.min(...shape.map((p) => p[0])) && cx <= b.position_x + Math.max(...shape.map((p) => p[0])) && cy >= b.position_y + Math.min(...shape.map((p) => p[1])) && cy <= b.position_y + Math.max(...shape.map((p) => p[1])));
    if (hits.length !== 1) throw new Error('Cannot unambiguously assign ' + object.name + ' to a bed. Arrange it before optimizing.');
    const bed = hits[0];
    if (!beds.includes(bed.number)) return;
    transform[9] -= bed.position_x; transform[10] -= bed.position_y;
    bounds[0] -= bed.position_x; bounds[2] -= bed.position_x;
    bounds[1] -= bed.position_y; bounds[3] -= bed.position_y;
    const printable = object.instancePrintable[instance] !== false;
    const usage = C.usage({ ...doc.model, objects: [{ ...object, instances: [transform], instancePrintable: [printable] }] });
    const tools = [...usage.filaments].filter(([, v]) => v.triangles > 0).map(([tool]) => tool);
    if (!tools.length) tools.push(object.volumes.find((v) => v.extruder > 0)?.extruder || object.extruder);
    items.push({ key: `${docIndex}:${ordinal}`, doc, id, ordinal, raw, object, transform, bounds, printable, tools, sourceBed: `${docIndex + 1}:${bed.number}` });
  });
  return items;
}

// Deterministic rectangular packing; orientations, Z, scale, paint and settings stay fixed.
function pack(items, shape, gap = 5, brim = 0) {
  const margin = 5;
  const bx0 = Math.min(...shape.map((p) => p[0])), by0 = Math.min(...shape.map((p) => p[1]));
  const bx1 = Math.max(...shape.map((p) => p[0])), by1 = Math.max(...shape.map((p) => p[1]));
  const x0 = bx0 + brim + margin, y0 = by0 + brim + margin, x1 = bx1 - brim - margin, y1 = by1 - brim - margin;
  if (shape.some((p) => ![bx0, bx1].includes(p[0]) || ![by0, by1].includes(p[1]))) throw new Error('Automatic packing needs a rectangular bed.');
  const bins = [];
  const ordered = items.filter((i) => i.printable).slice().sort((a, b) => (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) - (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) || a.key.localeCompare(b.key));
  for (const item of ordered) {
    const w = item.bounds[2] - item.bounds[0] + gap + brim * 2, h = item.bounds[3] - item.bounds[1] + gap + brim * 2;
    if (w > x1 - x0 + gap + brim * 2 + 1e-6 || h > y1 - y0 + gap + brim * 2 + 1e-6) return null;
    let best;
    for (let bi = 0; bi < bins.length; bi++) for (const r of bins[bi].free) {
      if (w <= r.w + 1e-6 && h <= r.h + 1e-6) {
        const score = Math.min(r.w - w, r.h - h);
        if (!best || score < best.score) best = { bi, r, score };
      }
    }
    if (!best) {
      bins.push({ placements: [], free: [{ x: x0, y: y0, w: x1 - x0 + gap + brim * 2, h: y1 - y0 + gap + brim * 2 }] });
      best = { bi: bins.length - 1, r: bins.at(-1).free[0] };
    }
    const bin = bins[best.bi], used = { x: best.r.x, y: best.r.y, w, h };
    bin.placements.push({ item, dx: used.x - item.bounds[0], dy: used.y - item.bounds[1] });
    const free = [];
    for (const r of bin.free) {
      if (used.x >= r.x + r.w || used.x + w <= r.x || used.y >= r.y + r.h || used.y + h <= r.y) { free.push(r); continue; }
      if (used.x > r.x) free.push({ ...r, w: used.x - r.x });
      if (used.x + w < r.x + r.w) free.push({ ...r, x: used.x + w, w: r.x + r.w - used.x - w });
      if (used.y > r.y) free.push({ ...r, h: used.y - r.y });
      if (used.y + h < r.y + r.h) free.push({ ...r, y: used.y + h, h: r.y + r.h - used.y - h });
    }
    bin.free = free.filter((r, i) => !free.some((s, j) => j !== i && s.x <= r.x && s.y <= r.y && s.x + s.w >= r.x + r.w && s.y + s.h >= r.y + r.h && (j < i || s.w !== r.w || s.h !== r.h)));
  }
  if (!bins.length) return null;
  // Disabled instances remain disabled, exactly once; they never affect print estimates.
  for (const item of items.filter((i) => !i.printable)) bins[0].placements.push({ item, dx: 0, dy: 0 });
  return bins.map((b) => b.placements);
}

async function writeProject(docs, bins, output) {
  const first = docs[0], group = structuredClone(first.group);
  const { x, y, step } = bedGeometry(group);
  const project = { ...structuredClone(first.project), objects: [], project: { ...first.project.project, id: randomUUID() }, config_containers: [group] };
  group.beds = bins.map((placements, index) => ({ ...structuredClone(placements[0].item.doc.group.beds[Number(placements[0].item.sourceBed.split(':')[1]) - 1]), position_x: x + step * index, position_y: y }));
  const maps = new Map(); let nextId = 1;
  for (const doc of docs) maps.set(doc, new Map([...doc.resources.keys()].map((id) => [id, nextId++])));
  const used = new Map(docs.map((doc) => [doc, new Set()]));
  function include(doc, id) {
    if (used.get(doc).has(id)) return;
    const raw = doc.resources.get(id);
    if (!raw) throw new Error('Missing native resource ' + id);
    used.get(doc).add(id);
    for (const m of raw.matchAll(/\bobjectid="(\d+)"/g)) include(doc, Number(m[1]));
  }
  const builds = [], objectRecords = new Map();
  for (const [bi, placements] of bins.entries()) for (const { item, dx, dy } of placements) {
    const ids = maps.get(item.doc), key = `${docs.indexOf(item.doc)}:${item.id}`;
    include(item.doc, item.id);
    if (!objectRecords.has(key)) {
      const object = structuredClone(item.doc.project.objects.find((o) => o.id === item.id));
      if (!object) throw new Error('Missing native object settings ' + item.id);
      object.id = ids.get(item.id);
      for (const volume of object.volumes) volume.id = ids.get(volume.id);
      delete object.instances;
      objectRecords.set(key, object); project.objects.push(object);
    }
    const original = item.doc.project.objects.find((o) => o.id === item.id)?.instances?.find((i) => i.ord === item.ordinal);
    if (original || !item.printable) (objectRecords.get(key).instances ||= []).push({ ...original, ord: builds.length, printable: item.printable });
    const t = item.transform.slice(); t[9] += dx + x + step * bi; t[10] += dy + y;
    builds.push(`<item objectid="${ids.get(item.id)}" transform="${t.join(' ')}" />`);
  }
  const resources = [], facets = [];
  for (const doc of docs) {
    const ids = maps.get(doc);
    // Prusa requires dependency order: meshes, then volumes, then model objects.
    for (const [id, raw] of doc.resources) if (used.get(doc).has(id)) resources.push(raw.replace(/(<object\b[^>]*\bid=")(\d+)(")/, (_, a, id, b) => a + ids.get(Number(id)) + b).replace(/\bobjectid="(\d+)"/g, (_, id) => `objectid="${ids.get(Number(id))}"`));
    for (const f of doc.facets) if (used.get(doc).has(f.id)) facets.push({ ...f, id: ids.get(f.id) });
  }
  let prefix = first.xml.slice(0, first.xml.indexOf('<resources'));
  for (const doc of docs) for (const m of doc.xml.slice(0, doc.xml.indexOf('<resources')).matchAll(/<metadata name="(slic3rpe:[^"]*PaintingVersion)"[^>]*>[\s\S]*?<\/metadata>/g)) if (!prefix.includes(`name="${m[1]}"`)) prefix += m[0] + '\n';
  const xml = prefix + '<resources>\n' + resources.join('\n') + '\n</resources>\n<build>\n' + builds.join('\n') + '\n</build>\n</model>';
  const files = [];
  for (const entry of first.zip.entries.values()) if (!['3d/3dmodel.model', 'metadata/prusaslicer3_project.json', 'metadata/slic3r_facets_annotation.json'].includes(entry.name.toLowerCase())) files.push({ name: entry.name, parts: [await entry.bytes()] });
  files.push({ name: '3D/3dmodel.model', parts: [xml] }, { name: 'Metadata/PrusaSlicer3_project.json', parts: [JSON.stringify(project, null, 2)] });
  if (facets.length) files.push({ name: 'Metadata/Slic3r_facets_annotation.json', parts: [JSON.stringify(facets)] });
  const blob = await C.writeZip(files);
  fs.writeFileSync(output, Buffer.from(await blob.arrayBuffer()));
}

function estimate(gcode) {
  const value = /^; estimated printing time \(normal mode\) = (.+)$/m.exec(gcode)?.[1];
  if (!value) throw new Error('Slicer did not report a normal-mode time estimate.');
  let seconds = 0;
  for (const m of value.matchAll(/(\d+)\s*([dhms])/g)) seconds += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 })[m[2]];
  if (!seconds) throw new Error('Invalid slicer time estimate: ' + value);
  return { seconds, display: value, toolChanges: Number(/^; total toolchanges = (\d+)$/m.exec(gcode)?.[1] || 0) };
}

function signature(item) {
  const settings = item.doc.project.objects.find((o) => o.id === item.id);
  const t = item.transform, b = C.instanceBounds(item.object, t), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const volumes = item.object.volumes.map((v, vi) => {
    const points = [];
    for (let n = 0; n < v.vertices.length; n += 3) {
      const [x, y, z] = v.vertices.subarray(n, n + 3);
      points.push(Math.round((x * t[0] + y * t[3] + z * t[6] + t[9] - cx) * 1e5), Math.round((x * t[1] + y * t[4] + z * t[7] + t[10] - cy) * 1e5), Math.round((x * t[2] + y * t[5] + z * t[8] + t[11]) * 1e5));
    }
    const metadata = { ...settings.volumes[vi] }; delete metadata.id;
    return { geometry: hash(JSON.stringify(points)), triangles: hash(JSON.stringify(Array.from(v.triangles))), paint: v.paint, metadata };
  });
  const metadata = { ...settings }; delete metadata.id; delete metadata.instances; delete metadata.volumes;
  return hash(stableJSON({ name: item.object.name, printable: item.printable, volumes, metadata }));
}

async function validateProject(file, slicer, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const before = await readProject(file), allBeds = before.group.beds.map((_, i) => i + 1);
  const native = path.join(directory, 'reopened.3mf');
  if (path.resolve(native) === path.resolve(file)) throw new Error('Validation must not overwrite its source project.');
  if (fs.existsSync(native)) fs.unlinkSync(native);
  W.runSlicer(slicer, ['--dont-arrange', '--export-3mf', '--output', native, file], path.join(directory, 'reopen.log'));
  if (!fs.existsSync(native)) throw new Error('PrusaSlicer did not save the combined project.');
  const after = await readProject(native);
  if (after.group.beds.length !== allBeds.length || !compatible(before.group, after.group)) throw new Error('Beds or settings changed during native reopen.');
  const expected = itemsFor(before, allBeds), actual = itemsFor(after, allBeds);
  const shape = after.group.configuration.printer_settings.bed_shape;
  const limits = [Math.min(...shape.map((p) => p[0])), Math.min(...shape.map((p) => p[1])), Math.max(...shape.map((p) => p[0])), Math.max(...shape.map((p) => p[1]))];
  for (const item of actual.filter((i) => i.printable)) if (item.bounds[0] < limits[0] + 0.01 || item.bounds[1] < limits[1] + 0.01 || item.bounds[2] > limits[2] - 0.01 || item.bounds[3] > limits[3] - 0.01) throw new Error('Object touches a bed edge; leave clearance before printing: ' + item.object.name);
  if (!isDeepStrictEqual(expected.map(signature).sort(), actual.map(signature).sort())) throw new Error('Geometry, painting, object settings or instance printability changed during native reopen.');
  const beds = [];
  for (const bed of allBeds) {
    const a = expected.filter((i) => i.sourceBed === `1:${bed}`), b = actual.filter((i) => i.sourceBed === `1:${bed}`);
    if (!isDeepStrictEqual(a.map(signature).sort(), b.map(signature).sort())) throw new Error('Object bed membership changed during native reopen.');
    const placement = (i) => signature(i) + ':' + i.bounds.map((v) => Math.round(v * 1e4)).join(',');
    if (!isDeepStrictEqual(a.map(placement).sort(), b.map(placement).sort())) throw new Error('Object placement changed during native reopen.');
    const input = path.join(directory, `bed-${bed}.3mf`);
    await writeProject([after], [b.map((item) => ({ item, dx: 0, dy: 0 }))], input);
    const result = await W.validate(input, slicer, path.join(directory, `bed-${bed}`));
    beds.push({ bed, objects: b.map((i) => i.object.name), ...estimate(fs.readFileSync(result.gcode, 'utf8')), validation: result });
  }
  return { passed: true, slicer: '3.0.0-alpha13', reopen: true, slice: true, native, beds, estimatedSeconds: beds.reduce((s, b) => s + b.seconds, 0), physicalPrint: false };
}

function cacheKey(bin) { return hash(JSON.stringify(bin.map(({ item, dx, dy }) => [item.key, item.transform, dx, dy]).sort())); }

async function optimize(inputs, options) {
  const { mode, output, slicer } = options;
  if (!['speed', 'fewer-beds'].includes(mode)) throw new Error('Choose --mode speed or --mode fewer-beds.');
  const reportFile = options.report || output + '.report.json', directory = output + '.validation';
  if (inputs.some((f) => [output, reportFile].includes(f)) || output === reportFile) throw new Error('Source, output and report must be different files.');
  if (inputs.some((f) => f.startsWith(directory + path.sep))) throw new Error('Source files must be outside the output validation directory.');
  if (!options.force && [output, reportFile, directory].some((f) => fs.existsSync(f))) throw new Error('Output or report exists. Choose another path or use --force.');
  const docs = await Promise.all(inputs.map(readProject));
  if (!docs.length) throw new Error('Supply at least one native project.');
  if (docs.some((d) => !compatible(docs[0].group, d.group))) throw new Error('Selected projects have different printer/material/process configurations. Normalize their presets before combining them.');
  for (const doc of docs) resolveBedModel(doc.group, slicer);
  if (docs.length > 1 && options.beds) throw new Error('--beds applies to one multi-bed input; multiple input filenames select all their single beds explicitly.');
  if (docs.some((d) => d.group.beds.length > 1) && !options.beds) throw new Error('Select source beds explicitly with --beds 1,2,... for a multi-bed project.');
  const selected = options.beds?.split(',').map(Number);
  if (selected && (!selected.length || new Set(selected).size !== selected.length || selected.some((n) => !Number.isInteger(n) || n < 1 || n > docs[0].group.beds.length))) throw new Error('Invalid or repeated source bed number.');
  const items = docs.flatMap((doc, i) => itemsFor(doc, selected || doc.group.beds.map((_, i) => i + 1), i));
  if (!items.some((i) => i.printable)) throw new Error('No printable instances selected.');
  for (const doc of docs) for (const bed of doc.group.beds) if (bed.custom_gcode || bed.wipe_tower) throw new Error('Custom bed G-code or wipe towers require a manual layout review.');
  const sourceBeds = [...new Set(items.map((i) => i.sourceBed))];
  const baseline = sourceBeds.map((bed) => items.filter((i) => i.sourceBed === bed).map((item) => ({ item, dx: 0, dy: 0 })));
  const shape = docs[0].group.configuration.printer_settings.bed_shape;
  const ps = docs[0].group.configuration.print_settings;
  const brim = ps.brim_type === 'no_brim' ? 0 : Number(ps.brim_width || 0) + Number(ps.brim_separation || 0);
  const filaments = docs[0].group.configuration.filament_settings;
  function packCompatible(parts) {
    const materials = new Set(parts.filter((i) => i.printable).flatMap((i) => i.tools).map((t) => JSON.stringify([filaments.filament_type[t - 1], filaments.bed_temperature[t - 1], filaments.first_layer_bed_temperature[t - 1]])));
    // Keep existing mixed-material beds intact; never introduce a new bed-temperature conflict.
    return materials.size > 1 ? null : pack(parts, shape, 5, brim);
  }
  const packed = packCompatible(items);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.mkdirSync(directory, { recursive: true });
  const report = { mode, sources: docs.map((d) => ({ file: d.file, sha256: hash(d.bytes) })), selectedBeds: sourceBeds, displayMesh: { path: docs[0].group.configuration.printer_settings.bed_custom_model, ...bedGeometry(docs[0].group) }, candidates: [], validation: { passed: false }, strategy: 'Translate XY only; preserve orientation, scale, layer heights, colours and tool assignments. Resolve the installed bed display mesh so GUI and CLI use the same bed origins. Speed selects the fastest evaluated layout, not a guaranteed global optimum.' };
  const cache = new Map();
  async function evaluate(bins, name) {
    const estimates = [];
    for (const bin of bins) {
      const key = cacheKey(bin);
      if (!cache.has(key)) {
        const index = cache.size + 1, input = path.join(directory, `trial-${index}.3mf`);
        process.stderr.write(`Slicing layout trial ${index}: ${bin.filter((p) => p.item.printable).map((p) => p.item.object.name).join(', ')}\n`);
        await writeProject(docs, [bin], input);
        try {
          const validation = await W.validate(input, slicer, path.join(directory, `trial-${index}`));
          cache.set(key, estimate(fs.readFileSync(validation.gcode, 'utf8')));
        } catch (error) { cache.set(key, { error: error.message }); }
      }
      estimates.push(cache.get(key));
    }
    const failure = estimates.find((e) => e.error);
    const candidate = failure ? { name, beds: bins.length, valid: false, reason: failure.error } : { name, beds: bins.length, valid: true, estimatedSeconds: estimates.reduce((s, b) => s + b.seconds, 0), toolChanges: estimates.reduce((s, b) => s + b.toolChanges, 0) };
    report.candidates.push(candidate);
    return { bins, ...candidate };
  }
  try {
    let best = await evaluate(baseline, 'Original bed separation');
    if (!best.valid) throw new Error('An original bed cannot be sliced: ' + best.reason);
    if (packed) {
      const candidate = await evaluate(packed, 'Pack for fewer beds');
      if (candidate.valid && (mode === 'fewer-beds' ? candidate.beds < best.beds || (candidate.beds === best.beds && candidate.estimatedSeconds < best.estimatedSeconds) : candidate.estimatedSeconds < best.estimatedSeconds)) best = candidate;
    }
    if (mode === 'speed') {
      // A source may already be one slow multicolour bed. Allow speed mode to split it.
      const groups = new Map();
      for (const item of items.filter((i) => i.printable)) {
        const key = [...new Set(item.tools)].sort((a, b) => a - b).join(',');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const materialBins = [];
      for (const group of groups.values()) {
        const bins = packCompatible(group);
        if (!bins) { materialBins.length = 0; break; }
        materialBins.push(...bins);
      }
      if (materialBins.length) {
        for (const item of items.filter((i) => !i.printable)) materialBins[0].push({ item, dx: 0, dy: 0 });
        const candidate = await evaluate(materialBins, 'Group parts by used tools');
        if (candidate.valid && candidate.estimatedSeconds < best.estimatedSeconds) best = candidate;
      }
      // Bounded greedy search: test material-related pairs first, then retain only measured improvements.
      let trials = 0, improved = true;
      while (improved && best.bins.length > 1 && trials < 16) {
        improved = false; const current = best, pairs = [];
        for (let a = 0; a < current.bins.length; a++) for (let b = a + 1; b < current.bins.length; b++) {
          const toolsA = new Set(current.bins[a].flatMap((p) => p.item.tools)), toolsB = new Set(current.bins[b].flatMap((p) => p.item.tools));
          pairs.push({ a, b, overlap: [...toolsA].filter((t) => toolsB.has(t)).length });
        }
        pairs.sort((a, b) => b.overlap - a.overlap);
        for (const { a, b } of pairs) {
          if (trials++ >= 16) break;
          const merged = packCompatible([...current.bins[a], ...current.bins[b]].map((p) => p.item));
          if (!merged || merged.length !== 1) continue;
          const bins = current.bins.filter((_, i) => i !== a && i !== b).concat(merged);
          const candidate = await evaluate(bins, `Merge tested beds ${a + 1} + ${b + 1}`);
          if (candidate.valid && candidate.estimatedSeconds < best.estimatedSeconds) { best = candidate; improved = true; }
        }
      }
    }
    const stage = path.join(directory, 'combined.3mf');
    await writeProject(docs, best.bins, stage);
    report.validation = await validateProject(stage, slicer, path.join(directory, 'combined'));
    report.selected = { beds: best.bins.length, estimatedSeconds: report.validation.estimatedSeconds, toolChanges: report.validation.beds.reduce((s, b) => s + b.toolChanges, 0) };
    const bytes = fs.readFileSync(report.validation.native), pending = output + '.pending-' + process.pid;
    try { fs.writeFileSync(pending, bytes, { flag: 'wx' }); fs.renameSync(pending, output); }
    finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
    report.output = output; report.outputSha256 = hash(bytes);
  } catch (error) { report.validation = { passed: false, reason: error.message }; throw error; }
  finally { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
  return report;
}

module.exports = { readProject, itemsFor, compatible, resolveBedModel, bedGeometry, pack, writeProject, estimate, signature, validateProject, optimize };
