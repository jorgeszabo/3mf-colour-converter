'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const C = require('./converter');

const PROCESS_KEYS = new Set(['layer_height', 'first_layer_height', 'perimeters', 'fill_density', 'fill_pattern', 'top_solid_layers', 'bottom_solid_layers', 'top_solid_min_thickness', 'bottom_solid_min_thickness', 'brim_width', 'brim_type', 'brim_separation', 'support_material', 'support_material_auto', 'support_material_threshold', 'support_material_style', 'support_material_pattern', 'support_material_spacing', 'support_material_contact_distance', 'support_material_bottom_contact_distance', 'support_material_interface_layers', 'support_material_interface_spacing', 'raft_layers', 'ironing', 'ironing_type', 'seam_position', 'fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_dist']);

function summary(model) {
  const u = C.usage(model);
  return { format: model.format, application: model.application, objects: model.objects.length, volumes: model.objects.reduce((n, o) => n + o.volumes.length, 0), instances: model.objects.reduce((n, o) => n + o.instances.length, 0), disabledInstances: model.objects.reduce((n, o) => n + o.instancePrintable.filter((p) => !p).length, 0), beds: Math.max(1, model.beds.length), triangles: u.triangles, paintedTriangles: u.paintedTriangles, usedColors: [...u.filaments.keys()].sort((a, b) => a - b), filaments: model.filaments, invalidPaint: model.badPaint };
}

function plan(model, data, options = {}) {
  const printer = { project3: structuredClone(data.group), format: 3, extruders: 8, colors: [], profiles: [] };
  const config = options.config || {};
  if (config.process !== undefined && !Object.hasOwn(data.processes || {}, config.process)) throw new Error('Choose an installed config.process preset.');
  const sourceHeight = (model.sourceSettings || []).filter((s) => s.scope.startsWith('group ') && s.scope.endsWith('/print_settings') && Number.isFinite(s.values.layer_height)).at(-1)?.values.layer_height;
  const process = config.process ? data.processes[config.process] : !options.targetProcess && Object.values(data.processes || {}).find((p) => Math.abs(p.layerHeight - sourceHeight) < 1e-6);
  if (process) {
    printer.project3.configuration.print_settings = structuredClone(process.printSettings);
    printer.project3.configuration.toolprint_settings = structuredClone(process.toolprintSettings);
    printer.project3.preset.print = structuredClone(process.print);
    printer.project3.preset.tools = structuredClone(process.tools);
  }
  const map = [];
  const assignments = [];
  const used = summary(model).usedColors;
  for (const source of used) {
    const tool = Number(config.map && config.map[source] !== undefined ? config.map[source] : source);
    if (!Number.isInteger(tool) || tool < 1 || tool > 8) throw new Error(`Source colour ${source} needs an explicit mapping to tool 1–8.`);
    map[source] = tool;
    const f = model.filaments[source - 1] || {};
    let materialName = (config.materials || {})[tool] || options.material;
    const names = Object.keys(data.materials);
    if (!materialName) materialName = names.find((n) => n === f.name) || names.find((n) => data.materials[n].material.root_id === f.name);
    if (!materialName) {
      const type = f.type === 'TPU' ? 'FLEX' : f.type;
      materialName = names.find((n) => n.startsWith(`Generic ${type}`) && data.materials[n].type === type);
    }
    if (!materialName || !data.materials[materialName]) throw new Error(`Choose a current material preset for source colour ${source} with --material or config.materials. Run 'profiles' for names.`);
    if (printer.profiles[tool - 1] && printer.profiles[tool - 1].material.name !== materialName) throw new Error('Merged colours request different materials on tool ' + tool);
    printer.profiles[tool - 1] = data.materials[materialName];
    const color = (config.colors || {})[tool] || f.color;
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Invalid colour for tool ' + tool);
    if (color) {
      if (printer.colors[tool - 1] && printer.colors[tool - 1] !== color && !options.allowColorMerge) throw new Error('Colour merging must be explicitly enabled.');
      printer.colors[tool - 1] = color;
    }
    assignments.push({ source, tool, sourceColor: f.color || null, sourceType: f.type || null, targetColor: color || null, material: materialName });
  }
  if (new Set(assignments.map((a) => a.tool)).size < assignments.length && !options.allowColorMerge) throw new Error('Colour merging must be explicitly enabled with --allow-color-merge.');
  const preserved = [];
  // Preserve familiar process choices, never source printer macros, temperatures or machine limits.
  if (!options.targetProcess && !config.process) for (const section of model.sourceSettings || []) {
    const key = section.scope.split('/')[1];
    if (!section.scope.startsWith('group ') || !['print_settings', 'toolprint_settings'].includes(key)) continue;
    for (const [name, value] of Object.entries(section.values)) {
      if (!PROCESS_KEYS.has(name) || !(name in printer.project3.configuration[key])) continue;
      if (key === 'print_settings') {
        printer.project3.configuration[key][name] = structuredClone(value);
        if (name in printer.project3.configuration.toolprint_settings) {
          printer.project3.configuration.toolprint_settings[name] = Array.from({ length: 8 }, () => structuredClone(value));
        }
      }
      else if (Array.isArray(value)) {
        // Uniform process choices should remain uniform if the user later changes tools.
        if (value.length && value.every((v) => isDeepStrictEqual(v, value[0]))) {
          printer.project3.configuration[key][name] = Array.from({ length: 8 }, () => structuredClone(value[0]));
        } else for (const a of assignments) {
          if (a.source <= value.length) printer.project3.configuration[key][name][a.tool - 1] = structuredClone(value[a.source - 1]);
        }
      }
      preserved.push(section.scope + '/' + name);
    }
  }
  if (config.segmentedRegionMaxWidth !== undefined) {
    if (!Number.isFinite(config.segmentedRegionMaxWidth) || config.segmentedRegionMaxWidth <= 0 || config.segmentedRegionMaxWidth > 10) throw new Error('config.segmentedRegionMaxWidth must be greater than zero and at most 10 mm.');
    printer.project3.configuration.print_settings.mmu_segmented_region_max_width = config.segmentedRegionMaxWidth;
  }
  if (config.infillTool !== undefined) {
    if (!Number.isInteger(config.infillTool) || !assignments.some((a) => a.tool === config.infillTool)) throw new Error('config.infillTool must be a mapped physical tool.');
    for (const key of ['infill_extruder', 'solid_infill_extruder', 'perimeter_extruder', 'bed_temperature_extruder']) printer.project3.configuration.print_settings[key] = config.infillTool;
  }
  const changes = C.settingsChanges(model, printer, map);
  return { printer, map, report: { source: summary(model), target: { slicer: data.slicerVersion, vendorVersion: data.vendorVersion, printer: data.printerName, toolCount: 8, nozzle: '0.4 HF', activeTools: [...new Set(assignments.map((a) => a.tool))], processPreset: printer.project3.preset.print.name, layerHeight: printer.project3.configuration.print_settings.layer_height }, assignments, preservedProcess: preserved, settingsChanges: changes, selectedBed: model.selectedBed || null, validation: { passed: false, reason: 'Not yet validated' } } };
}

function assertHardware(group) {
  const h = group.preset.hw_config;
  if (h.base_model !== 'COREONE_INDX' || h.tool_count !== 8 || Object.keys(h.tools).length !== 8 || Object.values(h.tools).some((t) => t.features.nozzle_diameter !== 0.4 || !t.features.nozzle_high_flow)) throw new Error('Expected CORE One INDX 8T with eight 0.4 mm HF tools.');
  if (group.preset.materials.some((m) => !m.name.includes('@COREONEINDX')) || group.preset.tools.some((t) => !t.name.includes('@COREONEINDX'))) throw new Error('Expected INDX-specific material and tool print presets.');
}

function runSlicer(slicer, args, logPath) {
  const r = spawnSync(slicer, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  const log = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(logPath, log);
  if (r.error || r.status !== 0) throw new Error(`PrusaSlicer failed; see ${logPath}: ${r.error ? r.error.message : r.status}`);
  return log;
}

async function validate(file, slicer, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const versionRun = spawnSync(slicer, ['--version'], { encoding: 'utf8' });
  const version = ((versionRun.stdout || '') + (versionRun.stderr || '')).trim();
  if (versionRun.error || versionRun.status !== 0 || !['3.0.0-alpha13', '3.0.0-alpha14'].includes(version)) throw new Error('Validation requires supported PrusaSlicer alpha13 or alpha14.');
  const zip = await C.readZip(fs.readFileSync(file));
  const project = JSON.parse(await zip.get('Metadata/PrusaSlicer3_project.json').text());
  if (project.config_containers.length !== 1 || project.config_containers[0].beds.length !== 1) throw new Error('Validate one bed at a time.');
  const group = project.config_containers[0];
  assertHardware(group);
  const model = await C.load3mf(fs.readFileSync(file));
  const shape = group.configuration.printer_settings.bed_shape;
  const [x0, y0, x1, y1] = [Math.min(...shape.map((p) => p[0])), Math.min(...shape.map((p) => p[1])), Math.max(...shape.map((p) => p[0])), Math.max(...shape.map((p) => p[1]))];
  let active = 0;
  for (const o of model.objects) for (const [i, t] of o.instances.entries()) {
    if (o.instancePrintable[i] === false) continue;
    active++;
    const local = t.slice(); local[9] -= group.beds[0].position_x; local[10] -= group.beds[0].position_y;
    const b = C.instanceBounds(o, local);
    if (b[0] < x0 - 0.01 || b[1] < y0 - 0.01 || b[2] > x1 + 0.01 || b[3] > y1 + 0.01) throw new Error(`Object ${o.name} is outside the target bed. Arrange it before conversion.`);
    for (const v of o.volumes.filter((v) => v.type === 'part')) for (let n = 0; n < v.vertices.length; n += 3) {
      const a = v.vertices;
      const z = a[n] * t[2] + a[n + 1] * t[5] + a[n + 2] * t[8] + t[11];
      if (z < -0.01 || z > group.configuration.printer_settings.max_print_height + 0.01) throw new Error(`Object ${o.name} is outside the target print height.`);
    }
  }
  if (!active) throw new Error('No printable instances on the selected bed.');
  // Temporary destinations prevent a previous successful export from masking failure.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-validate-'));
  try {
    const native = path.join(temp, 'reopened.3mf');
    const gcode = path.join(temp, 'sliced.gcode');
    runSlicer(slicer, ['--dont-arrange', '--export-3mf', '--output', native, file], path.join(directory, 'reopen.log'));
    if (!fs.existsSync(native)) throw new Error('PrusaSlicer did not export the reopened project.');
    const nativeZip = await C.readZip(fs.readFileSync(native));
    const nativeProject = JSON.parse(await nativeZip.get('Metadata/PrusaSlicer3_project.json').text());
    assertHardware(nativeProject.config_containers[0]);
    const reloaded = await C.load3mf(fs.readFileSync(native));
    if (C.usage(reloaded).paintedTriangles !== C.usage(model).paintedTriangles) throw new Error('Painting changed during native reopen.');
    if (summary(reloaded).disabledInstances !== summary(model).disabledInstances) throw new Error('Disabled instances changed during native reopen.');
    const log = runSlicer(slicer, ['--threads', '2', '--dont-arrange', '--export-gcode', '--output', gcode, native], path.join(directory, 'slice.log'));
    if (!/Slicing result exported to/.test(log) || /outside of the print volume|slicing failed|G-code export failed/i.test(log) || !fs.existsSync(gcode) || !fs.statSync(gcode).size) throw new Error('Slicing produced no valid G-code; inspect slice.log.');
    const text = fs.readFileSync(gcode, 'utf8');
    if (!text.includes('G427') || /^EXCLUDE_E_(START|END)\s*$/m.test(text)) throw new Error('Unexpected INDX G-code; check current printer presets.');
    fs.copyFileSync(native, path.join(directory, 'reopened.3mf'));
    fs.copyFileSync(gcode, path.join(directory, 'sliced.gcode'));
    return { passed: true, slicer: version, hardware: 'CORE One INDX 8T / 8 x 0.4 HF', reopen: true, slice: true, gcode: path.join(directory, 'sliced.gcode'), warnings: log.split('\n').filter((l) => /warning|error/i.test(l)), physicalPrint: false };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

module.exports = { plan, summary, validate, assertHardware, runSlicer };
