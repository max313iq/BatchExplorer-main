/* Aggregate every workspace package's i18n/resources.resjson into a single
 * web/resources/i18n/resources.<lang>.json that the runtime HttpLocalizer fetches.
 * Replaces what `bux build-translations` would normally produce. */
const fs = require('fs');
const path = require('path');

const sources = [
    'packages/bonito-core/i18n',
    'packages/bonito-ui/i18n',
    'packages/playground/i18n',
    'packages/react/i18n',
    'packages/service/i18n',
    'web/i18n',
];

// Languages to emit. We only have English resjsons in this monorepo, so
// every language file is the same English baseline.
const languages = ['en', 'cs', 'de', 'es', 'fr', 'hu', 'id', 'it', 'ja', 'ko',
    'nl', 'pl', 'pt-PT', 'pt-BR', 'ru', 'sv', 'tr', 'zh-Hans', 'zh-Hant'];

const merged = {};
for (const dir of sources) {
    const file = path.join(dir, 'resources.resjson');
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(json)) {
        if (k.startsWith('_')) continue; // resjson comments
        merged[k] = v;
    }
    console.log('merged', file, Object.keys(json).length, 'keys');
}

const outDir = 'web/resources/i18n';
fs.mkdirSync(outDir, { recursive: true });
for (const lang of languages) {
    fs.writeFileSync(path.join(outDir, `resources.${lang}.json`), JSON.stringify(merged, null, 2));
}
console.log('wrote', languages.length, 'language files to', outDir, '— total keys:', Object.keys(merged).length);
