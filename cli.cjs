#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const C = require('./converter');
const W = require('./workflow.cjs');

async function main(args) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' }, bed: { type: 'string' }, material: { type: 'string' }, config: { type: 'string' },
    report: { type: 'string' }, slicer: { type: 'string' }, mode: { type: 'string' }, beds: { type: 'string' }, 'accept-settings-changes': { type: 'boolean' },
    'allow-color-merge': { type: 'boolean' }, 'target-process': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const [command, input] = positionals;
  if (v.help || !command) {
    console.log('3mf-chat: inspect FILE | plan FILE | convert FILE -o OUTPUT.3mf | validate FILE | profiles\n          optimize NATIVE.3mf [...] --mode speed|fewer-beds -o OUTPUT.3mf\nOptions: --bed N --beds 1,2,... --material PRESET --config mapping.json --accept-settings-changes\n         --allow-color-merge --target-process --report FILE --slicer PATH --force\nConvert/optimize always reopen and slice in alpha13 before publishing. No printing or uploads.');
    return;
  }
  if (!['profiles', 'inspect', 'plan', 'convert', 'validate', 'optimize'].includes(command)) throw new Error('Unknown command: ' + command);
  const data = require('./indx-profiles');
  if (command === 'profiles') { console.log(JSON.stringify({ slicer: data.slicerVersion, vendorVersion: data.vendorVersion, printer: data.printerName, materials: Object.keys(data.materials) }, null, 2)); return; }
  if (!input) throw new Error('An input 3MF is required.');
  const file = path.resolve(input);
  const slicer = v.slicer || process.env.PRUSA_SLICER || '/Applications/PrusaSlicer-3.0.0-alpha13.app/Contents/MacOS/PrusaSlicer';
  if (command === 'optimize') {
    if (!v.output?.toLowerCase().endsWith('.3mf')) throw new Error('Choose a .3mf --output path.');
    if (v.bed || v.material || v.config || v['target-process'] || v['allow-color-merge']) throw new Error('Optimize preserves configured native settings; use --beds for source bed selection and convert materials first.');
    const result = await require('./layout.cjs').optimize(positionals.slice(1).map((f) => path.resolve(f)), { mode: v.mode, beds: v.beds, output: path.resolve(v.output), report: v.report ? path.resolve(v.report) : undefined, slicer, force: v.force });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (v.mode || v.beds) throw new Error('--mode and --beds are options for optimize. Use --bed N for conversion.');
  if (command === 'validate') {
    const zip = await C.readZip(fs.readFileSync(file)), entry = zip.get('Metadata/PrusaSlicer3_project.json');
    const project = entry && JSON.parse(await entry.text());
    const multiple = project && project.config_containers.some((g) => g.beds.length > 1);
    console.log(JSON.stringify(await (multiple ? require('./layout.cjs').validateProject(file, slicer, file + '.validation') : W.validate(file, slicer, file + '.validation')), null, 2)); return;
  }
  const source = fs.readFileSync(file);
  let model = await C.load3mf(source);
  if (command === 'inspect') { console.log(JSON.stringify(W.summary(model), null, 2)); return; }
  if (model.beds.length > 1 && v.bed === undefined) throw new Error(`Source has ${model.beds.length} beds. Select --bed N and convert each bed separately.`);
  if (v.bed !== undefined) model = C.selectBed(model, Number(v.bed));
  const p = W.plan(model, data, { material: v.material, config: v.config ? JSON.parse(fs.readFileSync(v.config, 'utf8')) : {}, allowColorMerge: v['allow-color-merge'], targetProcess: v['target-process'] });
  p.report.sourceFile = file;
  p.report.sourceSha256 = createHash('sha256').update(source).digest('hex');
  const print = () => console.log(JSON.stringify(p.report, null, 2));
  if (command === 'plan') { if (v.report) fs.writeFileSync(v.report, JSON.stringify(p.report, null, 2)); print(); return; }
  if (!v.output || !v.output.toLowerCase().endsWith('.3mf')) throw new Error('Choose a .3mf --output path.');
  const output = path.resolve(v.output);
  const report = path.resolve(v.report || output + '.report.json');
  if (output === file || report === file || report === output) throw new Error('Source, output and report must be different files.');
  if (!v.force && (fs.existsSync(output) || (v.report && fs.existsSync(report)) || fs.existsSync(output + '.validation'))) throw new Error('Output or validation report exists. Choose a new output or use --force.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify(p.report, null, 2));
  if (p.report.settingsChanges.length && !v['accept-settings-changes']) throw new Error(`Review ${report} or run plan, then use --accept-settings-changes after reviewing target settings.`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-convert-'));
  try {
    const stage = path.join(temp, 'converted.3mf');
    const blob = await C.convert(model, 'prusa', p.map, null, { printer: p.printer, allowColorMerge: v['allow-color-merge'] });
    const bytes = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(stage, bytes);
    p.report.validation = await W.validate(stage, slicer, output + '.validation');
    p.report.outputSha256 = createHash('sha256').update(bytes).digest('hex');
    // Atomic replacement on the destination filesystem; validation has already succeeded.
    const pending = output + '.pending-' + process.pid;
    try { fs.writeFileSync(pending, bytes, { flag: 'wx' }); fs.renameSync(pending, output); }
    finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
    p.report.output = output;
  } catch (e) { p.report.validation = { passed: false, reason: e.message }; throw e; }
  finally { fs.writeFileSync(report, JSON.stringify(p.report, null, 2)); fs.rmSync(temp, { recursive: true, force: true }); }
  print();
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
