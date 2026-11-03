// Refresh only the INDX 8T / Prusa 3 entry; retain upstream's other printer formats.
(function () {
  const data = window.INDX_PROFILES;
  const printer = window.PRUSA_PROFILES.find((p) => p.id === 'core1indx8t');
  printer.project3 = data.group;
  printer.materials3 = {};
  printer.filaments3 = {};
  for (const [name, m] of Object.entries(data.materials)) {
    const key = 'alpha13/' + name;
    const conditions = window.PRUSA_FILAMENTS.conditions.push(m.material.conditions || []) - 1;
    window.PRUSA_FILAMENTS.p3[key] = { ...m, material: { ...m.material, conditions } };
    printer.filaments3[m.material.root_id] = key;
    const type = m.type === 'FLEX' ? 'TPU' : m.type;
    if (!printer.materials3[type] || m.material.root_id === 'Generic ' + m.type) printer.materials3[type] = m;
  }
})();
