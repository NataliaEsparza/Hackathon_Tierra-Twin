const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const OUTPUT_FILE = path.join(ROOT_DIR, 'RESPALDO_CODIGO_TERRATWIN.txt');

const IGNORE_DIRS = new Set(['node_modules', '.git', '.angular', 'dist', '.vscode', 'coverage']);
const IGNORE_FILES = new Set(['package-lock.json', 'respaldo.js', 'RESPALDO_CODIGO_TERRATWIN.txt']);
const ALLOWED_EXTS = new Set(['.js', '.ts', '.html', '.css', '.json']);

let output = `RESPALDO COMPLETO DEL PROYECTO TERRA-TWIN\nGenerado el: ${new Date().toLocaleString('es-MX')}\n====================================================================\n\n`;
let fileCount = 0;

function scanFolder(currentPath) {
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        scanFolder(fullPath);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTS.has(ext) && !IGNORE_FILES.has(entry.name)) {
        const relativePath = path.relative(ROOT_DIR, fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        output += `\n####################################################################\n`;
        output += `ARCHIVO: ${relativePath}\n`;
        output += `####################################################################\n\n`;
        output += content + '\n';
        fileCount++;
      }
    }
  }
}

scanFolder(ROOT_DIR);
fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
console.log(`Listo: se exportaron ${fileCount} archivos en "${OUTPUT_FILE}"`);