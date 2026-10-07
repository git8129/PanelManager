import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..');
const source = join(root, 'PanelManager', 'wwwroot');
const output = join(root, '.sandbox', 'artifacts', 'web-demo');
const panel = join(output, 'panel');
mkdirSync(panel, { recursive: true });

// The desktop HTML is the asset manifest; export only its public frontend.
let html = readFileSync(join(source, 'index.html'), 'utf8');
const assets = new Set(['slim_v2.json']);
for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"\s]+)"/g)) {
    assets.add(match[1]);
}
for (const asset of assets) cpSync(join(source, asset), join(panel, asset));

// Load the demo adapter before DOMContentLoaded, without changing the host entry.
html = html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'">`)
    .replace('<title>Smart Touch Bar</title>', '<title>PanelManager — Static Demo</title>')
    .replace('</body>', '    <script src="demo.js"></script>\n</body>');
writeFileSync(join(panel, 'index.html'), html);
cpSync(join(scripts, 'web-demo', 'demo.js'), join(panel, 'demo.js'));
cpSync(join(scripts, 'web-demo', 'index.html'), join(output, 'index.html'));
cpSync(join(root, 'LICENSE'), join(output, 'LICENSE.txt'));
writeFileSync(join(output, '.nojekyll'), '');
console.log(`Static demo: ${output}`);
