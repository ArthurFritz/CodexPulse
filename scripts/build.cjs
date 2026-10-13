const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const template = read('src/index.template.html');
const styles = read('src/styles.css');
const app = ['src/session-data.js', 'src/views.js', 'src/app.js']
  .map((file) => `\n/* ${file} */\n${read(file)}`)
  .join('\n');
if (!template.includes('<!-- INLINE_STYLES -->') || !template.includes('/* INLINE_APP */')) {
  throw new Error('src/index.template.html is missing build placeholders');
}
const outputHtml = template
  .replace('<!-- INLINE_STYLES -->', `<style>\n${styles}\n</style>`)
  .replace('/* INLINE_APP */', app);
if (/<script[^>]+src="(?:\.{1,2}\/|\/)|<link[^>]+href="(?:\.{1,2}\/|\/)[^"]+\.css"/i.test(outputHtml)) {
  throw new Error('Build output must not reference local scripts or stylesheets');
}
fs.writeFileSync(path.join(root, 'index.html'), outputHtml);
const outputDir = path.join(root, 'dist');
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'index.html'), outputHtml);
console.log('Built standalone index.html and dist/index.html');
