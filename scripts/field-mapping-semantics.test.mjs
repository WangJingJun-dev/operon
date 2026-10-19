import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(tmpdir(),'operon-field-mapping-'));
try {
 const outfile=path.join(dir,'test.mjs');
 const modules=[
  ['buildReverseMapping','src/core/yaml-fields'],
  ['buildForwardMapping','src/core/yaml-fields'],
  ['getManagedYamlAliases','src/core/yaml-fields'],
  ['getVisiblePropertyName','src/core/yaml-fields'],
  ['parseTaskLine','src/core/parser'],
 ];
 await build({stdin:{contents:modules.map(([name,file])=>`export {${name}} from ${JSON.stringify(path.join(root,file))};`).join('\n'),resolveDir:root,loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent',alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')}});
 const {buildReverseMapping,buildForwardMapping,getManagedYamlAliases,getVisiblePropertyName,parseTaskLine}=await import(pathToFileURL(outfile).href);

 // Minimal stand-ins for the Operon system defaults: each canonical key maps to
 // itself. Only the keys exercised below need to be listed.
 const km=(canonicalKey,visiblePropertyName,type='text')=>({canonicalKey,visiblePropertyName,type,sync:'yes',enabled:true,isSystem:true});
 const defaultMappings=[
  km('operonId','operonId'),
  km('status','status'),
  km('taskIcon','taskIcon'),
  km('datetimeCreated','datetimeCreated','datetime'),
  km('datetimeModified','datetimeModified','datetime'),
 ];
 const rename=(mappings,canonicalKey,visiblePropertyName)=>mappings.map(m=>m.canonicalKey===canonicalKey?{...m,visiblePropertyName}:m);

 let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS',name);};

 await test('default mapping resolves canonical keys to themselves',()=>{
  const reverse=buildReverseMapping(defaultMappings);
  assert.equal(reverse.get('operonId'),'operonId');
  assert.equal(reverse.get('taskIcon'),'taskIcon');
 });

 await test('renamed visible property resolves to its canonical key',()=>{
  const reverse=buildReverseMapping(rename(defaultMappings,'taskIcon','图标'));
  assert.equal(reverse.get('图标'),'taskIcon');
 });

 await test('canonical and legacy keys remain readable after rename',()=>{
  const renamed=rename(defaultMappings,'datetimeCreated','创建时间');
  const reverse=buildReverseMapping(renamed);
  assert.equal(reverse.get('创建时间'),'datetimeCreated');
  assert.equal(reverse.get('datetimeCreated'),'datetimeCreated');
  assert.equal(reverse.get('dateCreated'),'datetimeCreated');
 });

 await test('alias list prefers the visible name and keeps canonical and legacy fallbacks',()=>{
  const renamed=rename(defaultMappings,'datetimeCreated','创建时间');
  assert.deepEqual(getManagedYamlAliases('datetimeCreated',renamed),['创建时间','datetimeCreated','dateCreated']);
  const iconAliases=getManagedYamlAliases('taskIcon',rename(defaultMappings,'taskIcon','图标'));
  assert.equal(iconAliases[0],'图标');
  assert.ok(iconAliases.includes('taskIcon'));
 });

 await test('write path uses the visible property name',()=>{
  const renamed=rename(defaultMappings,'taskIcon','图标');
  assert.equal(buildForwardMapping(renamed).get('taskIcon'),'图标');
  assert.equal(getVisiblePropertyName('taskIcon',renamed),'图标');
 });

 await test('inline parser reads the mapped non-ASCII key',()=>{
  const parsed=parseTaskLine('- [ ] 写报告 {{图标:: 🚀}}',0,'Note.md',rename(defaultMappings,'taskIcon','图标'));
  assert.equal(parsed.fields.find(f=>f.key==='taskIcon')?.value,'🚀');
 });

 await test('inline parser still reads the canonical key after rename',()=>{
  const parsed=parseTaskLine('- [ ] 写报告 {{taskIcon:: 🚀}}',0,'Note.md',rename(defaultMappings,'taskIcon','图标'));
  assert.equal(parsed.fields.find(f=>f.key==='taskIcon')?.value,'🚀');
 });

 await test('legacy dateCreated alias parses to datetimeCreated',()=>{
  const parsed=parseTaskLine('- [ ] Task {{dateCreated:: 2026-01-02}}',0,'Note.md',defaultMappings);
  assert.equal(parsed.fields.find(f=>f.key==='datetimeCreated')?.value,'2026-01-02');
 });

 await test('empty mapping leaves canonical parsing unchanged',()=>{
  const parsed=parseTaskLine('- [ ] 写报告 {{taskIcon:: 🚀}}',0,'Note.md',[]);
  assert.equal(parsed.fields.find(f=>f.key==='taskIcon')?.value,'🚀');
 });

 await test('operonId can be renamed and still resolves from either name',()=>{
  const renamed=rename(defaultMappings,'operonId','任务标识');
  const reverse=buildReverseMapping(renamed);
  assert.equal(reverse.get('任务标识'),'operonId');
  assert.equal(reverse.get('operonId'),'operonId');
  assert.deepEqual(getManagedYamlAliases('operonId',renamed),['任务标识','operonId']);
  const parsed=parseTaskLine('- [ ] 写报告 {{任务标识:: abc1234}}',0,'Note.md',renamed);
  assert.equal(parsed.operonId,'abc1234');
  const fallback=parseTaskLine('- [ ] 写报告 {{operonId:: abc1234}}',0,'Note.md',renamed);
  assert.equal(fallback.operonId,'abc1234');
 });

 console.log(`${count}/${count} field mapping semantics tests passed`);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
