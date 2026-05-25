/* Fallback for `bux build-translations` — generates each workspace
 * package's src/generated/localization/resources.ts from its
 * i18n/resources.resjson. Use this when the `bux` CLI tool is not
 * installed (e.g. on a fresh clone or when lerna bootstrap fails on a
 * Node runtime that nx's native module doesn't support).
 *
 * Usage: node eng/scripts/build-localization-types.js
 */
const fs = require('fs');
const path = require('path');
const targets = [
  ['packages/bonito-core', 'BonitoCoreResourceStrings'],
  ['packages/bonito-ui',   'BonitoUiResourceStrings'],
  ['packages/playground',  'PlaygroundResourceStrings'],
  ['packages/react',       'ReactResourceStrings'],
  ['packages/service',     'ServiceResourceStrings'],
  ['web',                  'ExplorerWebResourceStrings'],
];
for (const [dir, ifaceName] of targets) {
  const resjsonPath = path.join(dir, 'i18n', 'resources.resjson');
  if (!fs.existsSync(resjsonPath)) { console.log('skip (no resjson)', dir); continue; }
  const json = JSON.parse(fs.readFileSync(resjsonPath, 'utf8'));
  const keys = Object.keys(json).filter(k => !k.startsWith('_'));
  const outDir = path.join(dir, 'src', 'generated', 'localization');
  fs.mkdirSync(outDir, {recursive:true});
  const outFile = path.join(outDir, 'resources.ts');
  let content = '/* AUTO-GENERATED — DO NOT EDIT */\n';
  content += 'export interface ' + ifaceName + ' {\n';
  for (const k of keys) content += '    ' + JSON.stringify(k) + ': string;\n';
  content += '}\n';
  content += '// eslint-disable-next-line @typescript-eslint/no-empty-interface\n';
  content += 'export interface GeneratedResourceStrings extends ' + ifaceName + ' {}\n';
  fs.writeFileSync(outFile, content);
  console.log('wrote', outFile, '('+keys.length+' keys)');
}
