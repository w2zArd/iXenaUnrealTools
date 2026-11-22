const childProcess = require('node:child_process');
let ts;
try {
  ts = require('typescript');
} catch {
  const root = childProcess.execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  ts = require(require('node:path').join(root, 'typescript'));
}
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, {recursive:true});
let failures = 0;
for (const filename of fs.readdirSync(path.join(root, 'src')).filter(x=>x.endsWith('.ts'))) {
  const abs=path.join(root,'src',filename);
  const source=fs.readFileSync(abs,'utf8');
  const output=ts.transpileModule(source,{fileName:filename,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,sourceMap:true}});
  for (const diagnostic of output.diagnostics || []) {
    const msg=ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n');
    process.stderr.write(`${filename}: ${msg}\n`);
    failures++;
  }
  fs.writeFileSync(path.join(dist,filename.replace(/\.ts$/,'.js')),output.outputText);
  if (output.sourceMapText) fs.writeFileSync(path.join(dist,filename.replace(/\.ts$/,'.js.map')),output.sourceMapText);
}
if (failures) process.exit(1);
console.log('Offline TypeScript transpile/syntax diagnostics passed');
