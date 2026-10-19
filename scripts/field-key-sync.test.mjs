import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(tmpdir(),'operon-key-sync-'));
try {
 const outfile=path.join(dir,'test.mjs');
 const modules=[
  ['planFrontmatterKeySync','src/core/field-key-sync'],
  ['applyFrontmatterKeySyncPlan','src/core/field-key-sync'],
  ['syncInlineTaskLine','src/core/field-key-sync'],
 ];
 await build({stdin:{contents:modules.map(([name,file])=>`export {${name}} from ${JSON.stringify(path.join(root,file))};`).join('\n'),resolveDir:root,loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent',alias:{obsidian:path.join(root,'scripts/test-support/obsidian.ts')}});
 const {planFrontmatterKeySync,applyFrontmatterKeySyncPlan,syncInlineTaskLine}=await import(pathToFileURL(outfile).href);

 const km=(canonicalKey,visiblePropertyName,type='text')=>({canonicalKey,visiblePropertyName,type,sync:'yes',enabled:true,isSystem:true});
 const zhMappings=[
  km('operonId','任务标识'),km('status','状态'),km('priority','优先级'),
  km('dateDue','预计结束'),km('dateScheduled','预计开始'),
  km('datetimeCreated','创建时间','datetime'),km('datetimeModified','修改时间','datetime'),
  km('taskIcon','图标'),km('taskColor','颜色'),km('note','备注'),
  km('parentTask','父任务'),km('progress','进度'),
  km('directSubtaskCount','直属子任务数'),km('treeDescendantCount','后代任务数'),
 ];
 const enMappings=zhMappings.map(m=>({...m,visiblePropertyName:m.canonicalKey}));

 let count=0;const test=async(name,run)=>{await run();count++;console.log('PASS',name);};

 const apply=(fm,mappings,direction)=>{
  const plan=planFrontmatterKeySync(fm,mappings,direction);
  const copy=JSON.parse(JSON.stringify(fm));
  applyFrontmatterKeySyncPlan(copy,plan);
  return {result:copy,plan};
 };

 await test('frontmatter en->zh moves values verbatim',()=>{
  const fm={operonId:'abc1234',dateDue:'2026-01-01',priority:'2',note:'hello',unrelated:'keep'};
  const {result,plan}=apply(fm,zhMappings,'to-visible');
  assert.deepEqual(result,{任务标识:'abc1234',预计结束:'2026-01-01',优先级:'2',备注:'hello',unrelated:'keep'});
  assert.equal(plan.moves.length,4);
  assert.equal(plan.conflicts.length,0);
 });

 await test('frontmatter round trip restores byte-identical values',()=>{
  const original={operonId:'abc1234',dateDue:'2026-01-01',taskIcon:'🚀',progress:'42'};
  const {result:zh}=apply(original,zhMappings,'to-visible');
  const {result:back,plan:backPlan}=apply(zh,zhMappings,'to-canonical');
  assert.deepEqual(back,original);
  assert.equal(backPlan.moves.length,4);
 });

 await test('conflicting duplicate keys are skipped and counted',()=>{
  const fm={operonId:'abc1234',任务标识:'zzzz999'};
  const {result,plan}=apply(fm,zhMappings,'to-visible');
  assert.deepEqual(result,fm);
  assert.equal(plan.conflicts.length,1);
 });

 await test('same-value duplicate keys dedupe to the target name',()=>{
  const fm={operonId:'abc1234',任务标识:'abc1234',dateDue:'2026-01-01'};
  const {result,plan}=apply(fm,zhMappings,'to-visible');
  assert.deepEqual(result,{任务标识:'abc1234',预计结束:'2026-01-01'});
  assert.equal(plan.conflicts.length,0);
 });

 await test('legacy alias migrates to the visible name and back to canonical',()=>{
  const fm={dateCreated:'2026-01-02'};
  const {result:zh,plan}=apply(fm,zhMappings,'to-visible');
  assert.deepEqual(zh,{创建时间:'2026-01-02'});
  assert.equal(plan.moves.length,1);
  const {result:back}=apply(zh,zhMappings,'to-canonical');
  assert.deepEqual(back,{datetimeCreated:'2026-01-02'});
 });

 await test('unmapped keys and identity-styled mappings are untouched',()=>{
  const fm={operonId:'abc1234',estimate:'3600'};
  const {result,plan}=apply(fm,enMappings,'to-visible');
  assert.deepEqual(result,fm);
  assert.equal(plan.moves.length,0);
 });

 await test('inline task line migrates token keys without touching values',()=>{
  const line='- [ ] 写报告 {{operonId:: abc1234}} {{dateDue:: 2026-01-01}} {{estimate:: 3600}}';
  const {line:zh,changedTokens}=syncInlineTaskLine(line,zhMappings,'to-visible');
  assert.equal(zh,'- [ ] 写报告 {{任务标识:: abc1234}} {{预计结束:: 2026-01-01}} {{estimate:: 3600}}');
  assert.equal(changedTokens,2);
  const {line:back,changedTokens:backTokens}=syncInlineTaskLine(zh,zhMappings,'to-canonical');
  assert.equal(back,line);
  assert.equal(backTokens,2);
 });

 await test('inline legacy alias token normalizes to visible name then canonical',()=>{
  const {line:zh}=syncInlineTaskLine('- [ ] t {{dateCreated:: 2026-01-02}}',zhMappings,'to-visible');
  assert.equal(zh,'- [ ] t {{创建时间:: 2026-01-02}}');
  const {line:back}=syncInlineTaskLine(zh,zhMappings,'to-canonical');
  assert.equal(back,'- [ ] t {{datetimeCreated:: 2026-01-02}}');
 });

 await test('inline line with both forms and differing values is left untouched',()=>{
  const line='- [ ] t {{operonId:: abc1234}} {{任务标识:: zzzz999}}';
  const {line:out,changedTokens}=syncInlineTaskLine(line,zhMappings,'to-visible');
  assert.equal(out,line);
  assert.equal(changedTokens,0);
 });

 await test('second sync run is a no-op (idempotent)',()=>{
  const fm={operonId:'abc1234',dateDue:'2026-01-01'};
  const {result:zh}=apply(fm,zhMappings,'to-visible');
  const {plan:again}=apply(zh,zhMappings,'to-visible');
  assert.equal(again.moves.length,0);
  assert.equal(again.conflicts.length,0);
  const {line:zhLine,changedTokens}=syncInlineTaskLine('- [ ] t {{任务标识:: abc1234}}',zhMappings,'to-visible');
  assert.equal(zhLine,'- [ ] t {{任务标识:: abc1234}}');
  assert.equal(changedTokens,0);
  const {line:enLine,changedTokens:enTokens}=syncInlineTaskLine('- [ ] t {{operonId:: abc1234}}',enMappings,'to-canonical');
  assert.equal(enLine,'- [ ] t {{operonId:: abc1234}}');
  assert.equal(enTokens,0);
 });

 await test('non-task content passes through unchanged',()=>{
  const {line,changedTokens}=syncInlineTaskLine('随机文本 {{something:: else}} 更多',zhMappings,'to-visible');
  assert.equal(line,'随机文本 {{something:: else}} 更多');
  assert.equal(changedTokens,0);
  const {plan}=apply({random:'value'},zhMappings,'to-visible');
  assert.equal(plan.moves.length,0);
 });

 console.log(`${count}/${count} field key sync tests passed`);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
