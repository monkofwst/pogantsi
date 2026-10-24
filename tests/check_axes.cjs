const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const elements = new Map();
const element = (id) => {
  if (!elements.has(id))
    elements.set(id, {
      textContent: '',
      innerHTML: '',
      style: {},
      value: '',
      hidden: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
    });
  return elements.get(id);
};
const context = vm.createContext({
  console,
  performance,
  Float32Array,
  Uint8ClampedArray,
  Map,
  Set,
  Math,
  Number,
  String,
  Array,
  JSON,
  window: {},
  document: {
    getElementById: element,
    createElement() {
      throw Error('Canvas adapter not installed');
    },
  },
  requestAnimationFrame() {},
  setTimeout,
  clearTimeout,
  ResizeObserver: class {
    observe() {}
  },
});
const code = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\nboot\(\);\s*$/, '');
vm.runInContext(
  code +
    '\nglobalThis.api={normalizeRows,createPoints,parseCSV,setData,selectProfile,updateAxisReadout,bindUI,state,CloudRenderer};',
  context
);
const api = context.api;
const input = [
  {
    person_id: 'p1',
    target: '0.91',
    contribution_G2: '.2',
    contribution_G3: '.4',
    contribution_G4: '.6',
    G2: 'false',
    G3: 'true',
    G4: 'false',
    reliable_segments: '15',
    core_mechanisms: '2',
  },
  {
    person_id: 'p2',
    target: '0',
    contribution_G2: '0',
    contribution_G3: '0',
    contribution_G4: '0',
    G2: 'false',
    G3: 'false',
    G4: 'false',
  },
  {
    person_id: 'p3',
    target: '.99',
    contribution_G2: '.7',
    contribution_G3: '.5',
    contribution_G4: '.8',
    G2: true,
    G3: true,
    G4: true,
  },
  {
    person_id: 'bad',
    target: '.5',
    contribution_G2: '',
    contribution_G3: '.5',
    contribution_G4: '.6',
  },
];
api.setData(input, 'users_scored.csv');
assert.equal(api.state.rows.length, 3);
const p = api.state.points;
[-3.6, -1.2, 1.2].forEach((v, i) => assert(Math.abs(p.positions[i] - v) < 1e-5));
assert.deepEqual(Array.from(p.featurePositions.slice(0, 3)), [-6, 6, -6]);
assert.equal(api.state.rows[api.state.top[0]].passenger_id, 'p3');
assert.equal(api.state.rows[0].flight_count, 15);
api.selectProfile(0, false);
assert.match(element('profile-coords').textContent, /X · G2 = 0.200/);
assert.equal(element('profile-dests').textContent, '—');
const modes = ['contributions', 'flags'].map((mode) => ({
  dataset: { mode },
  classList: { toggle() {} },
}));
context.document.querySelectorAll = (selector) => (selector === '.mode' ? modes : []);
context.document.addEventListener = () => {};
api.bindUI();
modes[1].onclick();
assert.equal(api.state.targetMix, 1);
assert.match(element('profile-coords').textContent, /X · G2 = 0.000/);
assert.match(element('profile-coords').textContent, /Y · G3 = 1.000/);
const fallback = api.normalizeRows([
  { person_id: 'q', target: '.3', G2: 'true', G3: '0', G4: 'false' },
])[0];
assert.equal(fallback.x, 1);
assert.equal(fallback.y, 0);
assert.equal(fallback.z, 0);
assert.throws(
  () => api.normalizeRows([{ passenger_id: 'q', x: 1, y: 2, z: 3, anomaly_score: 0.5 }]),
  /contribution_G2/
);
assert.throws(
  () =>
    api.normalizeRows([
      { person_id: 'q', target: '.5', contribution_G2: 2, contribution_G3: 0, contribution_G4: 0 },
    ]),
  /корректных/
);
const duplicate = api.normalizeRows([input[0], input[0]]);
assert.equal(duplicate.length, 1);
const demo = api.normalizeRows(
  api.parseCSV(fs.readFileSync(path.join(root, 'data/passengers.csv'), 'utf8'))
);
assert.equal(demo.length, 100000);
assert(
  demo.every((row) => [row.x, row.y, row.z, row.anomaly_score].every((v) => v >= 0 && v <= 1))
);
assert(
  demo.every(
    (row) =>
      Math.abs(
        row.anomaly_score -
          (1 -
            (1 - Number(row.contribution_G2)) *
              (1 - Number(row.contribution_G3)) *
              (1 - Number(row.contribution_G4)))
      ) < 0.00005
  )
);
assert(demo.every((row) => row.axisSource === 'behavior'));
const behavior = api.normalizeRows([
  {
    person_id: 'behavior',
    target: '.6',
    behavior_x: '.25',
    behavior_y: '.5',
    behavior_z: '.75',
    contribution_G2: 0,
    contribution_G3: 0,
    contribution_G4: 0,
    G2: false,
    G3: false,
    G4: false,
  },
])[0];
assert.equal(behavior.x, 0.25);
assert.equal(behavior.y, 0.5);
assert.equal(behavior.z, 0.75);
assert.equal(behavior.anomaly_score, 0.6);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('id="axis-mode-label"'));
assert(html.includes('data-mode="contributions"'));
assert(!html.includes('data-mode="similarity"'));
try {
  const { createCanvas } = require('@napi-rs/canvas');
  const makeCanvas = () => {
    const c = createCanvas(1100, 760);
    c.style = {};
    c.parentElement = {};
    c.getBoundingClientRect = () => ({ width: 1100, height: 760, left: 0, top: 0 });
    c.addEventListener = () => {};
    return c;
  };
  context.document.createElement = () => makeCanvas();
  const canvas = makeCanvas(),
    renderer = new api.CloudRenderer(canvas);
  api.state.mode = 'contributions';
  api.state.mix = 0;
  api.state.targetMix = 0;
  api.setData(demo, 'DEMO');
  renderer.updateData(api.state.points);
  renderer.draw();
  if (process.env.PARALLAX_QA_IMAGE)
    fs.writeFileSync(process.env.PARALLAX_QA_IMAGE, canvas.toBuffer('image/png'));
  console.log('Canvas rendering: OK');
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND')
    console.log('Optional Canvas adapter unavailable; data/axis checks completed');
  else throw error;
}
console.log(
  'G2/G3/G4 axes, import aliases, flags, validation, ranking and 100000 demo profiles: OK'
);
