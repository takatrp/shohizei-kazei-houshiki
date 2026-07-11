'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

for(const file of ['tax-engine.js', 'release-history.js', 'forstaff.png']){
  if(!fs.existsSync(path.join(root, file))) throw new Error(`Missing static asset: ${file}`);
}

for(const file of ['tax-engine.js', 'release-history.js']){
  new Function(fs.readFileSync(path.join(root, file), 'utf8'));
}

for(const match of html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)){
  if(match[1].trim()) new Function(match[1]);
}

for(const marker of ['release-history.js', 'tax-engine.js', 'latestRelease', 'methodCards', 'projectionRows']){
  if(!html.includes(marker)) throw new Error(`Missing HTML marker: ${marker}`);
}

console.log('Static validation passed.');
