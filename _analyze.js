const fs = require('fs');
const raw = fs.readFileSync(process.env.TRANSCRIPT, 'utf8');
const re = /"kind":"thinking","value":"((?:[^"\\]|\\.)*)"/g;
let m;
let shown = 0;
const samples = [];
while ((m = re.exec(raw)) !== null) {
  if (shown >= 40) break;
  let v;
  try { v = JSON.parse('"' + m[1] + '"'); } catch (e) { v = m[1]; }
  if (v && v.trim().length > 40) { samples.push(v.trim()); shown++; }
}
console.log('sample thinking texts:', samples.length);
samples.slice(0, 12).forEach((s, i) => {
  console.log('--- [' + i + '] ---');
  console.log(s.slice(0, 240));
});
