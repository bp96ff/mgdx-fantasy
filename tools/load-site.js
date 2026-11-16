// Loads the site's data code into Node for the tools/run-*.js scripts. The site's files expect a browser
// `window`; here it is just the global object. MGDX_CONFIG picks a past season's config (js/seasons/<year>.js,
// set by tools/build-season.js). The site's own files are read from disk instead of fetched.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadSite(files) {
  globalThis.window = globalThis;
  const config = process.env.MGDX_CONFIG || 'js/config.js';
  for (const file of [config, ...files]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
  }
  const { ARCHIVE } = globalThis.MGDX;
  // The site's own files (e.g. data/cross-schedule.json, or a past season's saved files) are read from disk.
  const webFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => (/^https?:/.test(url)
    ? webFetch(url, options)
    : new Response(fs.readFileSync(path.join(ROOT, url))));
  // Where this season's saved files go: data/ for the current season, the season's own folder otherwise.
  const dataDir = path.join(ROOT, ARCHIVE ? ARCHIVE.dir : 'data');
  return { ...globalThis, ROOT, dataDir };
}

module.exports = { loadSite };
