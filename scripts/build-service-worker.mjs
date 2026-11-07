import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function files(path){const result=[];for(const entry of await readdir(path,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const full=`${path}/${entry.name}`;if(entry.isDirectory())result.push(...await files(full));else if(!full.endsWith('/sw.js'))result.push(full);}return result;}
const paths=await files('dist');const hash=createHash('sha256');for(const path of paths)hash.update(await readFile(path));
const cache=`kelvin-shell-${hash.digest('hex').slice(0,16)}`;
const html=await readFile('dist/index.html','utf8');
const initialSet=new Set(['/index.html','/manifest.webmanifest','/mark.svg','/fonts/plex-sans-latin.woff2',...Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g),match=>match[1])]);
const manifest=JSON.parse(await readFile('dist/.vite/manifest.json','utf8'));
const visited=new Set();
function include(key){if(visited.has(key))return;visited.add(key);const item=manifest[key];if(!item)return;if(item.file)initialSet.add('/'+item.file);for(const css of item.css||[])initialSet.add('/'+css);for(const asset of item.assets||[])if(asset.endsWith('.woff2'))initialSet.add('/'+asset);for(const imported of item.imports||[])include(imported);}
// Every app screen loaded on demand (a lazy import under src/) is precached so it opens offline.
// Library chunks loaded on demand (diagram renderers) stay cached on first use only.
for(const [key,item] of Object.entries(manifest))if(item.isDynamicEntry&&(item.src||key).startsWith('src/'))include(key);
const initial=[...initialSet];
await writeFile('dist/sw.js',`const CACHE=${JSON.stringify(cache)};const FILES=${JSON.stringify(paths.map(p=>'/'+p.slice(5)))};const INITIAL=${JSON.stringify(initial)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(INITIAL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('kelvin-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/')||url.pathname.startsWith('/collaboration'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/index.html')));return;}event.respondWith(caches.match(event.request,{ignoreVary:true}).then(async hit=>{if(hit)return hit;const response=await fetch(event.request);if(response.ok&&FILES.includes(url.pathname))event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,response.clone())));return response;}));});
`);
console.info(`Service worker generated: ${cache}, ${initial.length} initial assets; ${paths.length} assets cached on demand.`);
