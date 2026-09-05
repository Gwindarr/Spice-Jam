const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
for (const entry of ['index.html', 'mobile-controls.js', 'world.js', 'assets', 'vendor']) {
  fs.cpSync(path.join(root, entry), path.join(output, entry), { recursive: true });
}
console.log('Built public game files in dist/');
