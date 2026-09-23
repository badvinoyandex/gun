// Сборка в один HTML-файл: модули src/ склеиваются esbuild, three.js остаётся
// на CDN через import map. Результат открывается двойным щелчком, без сервера.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  write: false,
  minify: false,
  legalComments: 'none',
  target: 'es2022',
  external: ['three', 'three/addons/*']
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="./src/main.js"></script>', () => `<script type="module">\n${js}\n</script>`);
if (html.includes('src="./src/main.js"')) throw new Error('не удалось встроить бандл');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/tikhiy_bor.html', html);
console.log(`dist/tikhiy_bor.html — ${(html.length / 1024).toFixed(0)} КБ`);
