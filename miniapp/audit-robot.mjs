import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const miniappDir = fileURLToPath(new URL('.', import.meta.url));
const webDir = fileURLToPath(new URL('./web/', import.meta.url));
const upstreamDir = fileURLToPath(new URL('./upstream/', import.meta.url));
const html = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('./api.mjs', import.meta.url), 'utf8');
const webFiles = readdirSync(webDir);
const upstreamFiles = existsSync(upstreamDir) ? readdirSync(upstreamDir) : [];
const webTexts = Object.fromEntries(webFiles.map(name => [name, readFileSync(new URL('./web/' + name, import.meta.url), 'utf8')]));

let tests = 0;
function check(name, fn) {
  fn();
  tests++;
  console.log('PASS', name);
}

const robotName = /robot(?:-expressive)?\.(?:js|css|webp)|participant_alpha-robot\.(?:js|css)/i;
const loveIs = /Love\s+Is|Любовь\s+это/i;

check('HTML has no robot filenames or Family Cards logo text', () => {
  assert(!robotName.test(html), 'robot filename found in HTML');
  assert(!loveIs.test(html), 'Family Cards text found in HTML');
  assert(!/heart.*arrow|arrow.*heart|<svg[^>]*>[\s\S]*<path[^>]*d="M6 86L105 5"/i.test(html), 'heart-arrow logo SVG found in HTML');
});

check('API has no robot filenames or Family Cards copy', () => {
  assert(!robotName.test(api), 'robot filename found in api.mjs');
  assert(!loveIs.test(api), 'Family Cards text found in api.mjs');
});

check('web assets have no robot filenames or Family Cards copy', () => {
  for (const name of webFiles) assert(!robotName.test(name), 'robot asset present in web/: ' + name);
  for (const [name, text] of Object.entries(webTexts)) {
    assert(!robotName.test(text), 'robot filename found in web/' + name);
    assert(!loveIs.test(text), 'Family Cards text found in web/' + name);
  }
});

check('robot/upstream mascot files are absent', () => {
  for (const name of [...webFiles, ...upstreamFiles]) {
    assert(!robotName.test(name), 'mascot file still present: ' + name);
  }
  for (const requiredAbsent of ['robot.js', 'robot.css', 'robot-expressive.webp']) {
    assert(!existsSync(new URL('./web/' + requiredAbsent, import.meta.url)), 'web/' + requiredAbsent + ' still exists');
  }
  for (const requiredAbsent of ['participant_alpha-robot.js', 'participant_alpha-robot.css']) {
    assert(!existsSync(new URL('./upstream/' + requiredAbsent, import.meta.url)), 'upstream/' + requiredAbsent + ' still exists');
  }
});

console.log('PUBLIC MINIAPP ASSET GATE:', tests, 'checks passed');
