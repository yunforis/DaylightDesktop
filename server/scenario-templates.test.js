import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_TEMPLATES, normalizeTemplate, exportTemplate, importTemplate } from '../shared/scenario-templates.js';

test('六个内置模板定义具有可验证的字段、阶段、能力与业务边界', () => {
  assert.deepEqual(OFFICIAL_TEMPLATES.map(template => template.id), [
    'recruitment', 'invoices',
    'graduate-admission', 'research-applications', 'job-applications', 'research-publications',
  ]);
  assert.equal(new Set(OFFICIAL_TEMPLATES.map(template => template.id)).size, OFFICIAL_TEMPLATES.length);
  assert.equal(OFFICIAL_TEMPLATES[0].catalog, 'official');
  assert.equal(OFFICIAL_TEMPLATES[1].catalog, 'official');
  assert.equal(OFFICIAL_TEMPLATES[2].catalog, 'community');
  const paper = OFFICIAL_TEMPLATES.find((template) => template.id === 'research-publications');
  assert.equal(paper.stages.find((stage) => stage.id === 'submitted').evidence, true);
  assert.equal(paper.stages.find((stage) => stage.id === 'preparing').evidence, undefined);
  for (const template of OFFICIAL_TEMPLATES) {
    const clean = normalizeTemplate(template);
    assert.ok(clean.fields.length && clean.stages.length && clean.samples.length);
    assert.ok(clean.capabilities.includes('mail.read'));
  }
});
test('模板包只导出定义白名单，隔离实例和凭据，往返保留配置', () => {
  const template = OFFICIAL_TEMPLATES.find((item) => item.id === 'graduate-admission');
  const pack = exportTemplate({...template, apiKey:'secret', emails:[{body:'private'}], items:[{title:'private'}], ownerUserId:'user'});
  assert.equal(JSON.stringify(pack).includes('secret'), false);
  assert.equal(JSON.stringify(pack).includes('private'), false);
  assert.deepEqual(importTemplate(pack),normalizeTemplate(template));
});
test('拒绝重复/危险字段、未知工具与不兼容格式', () => {
  const t = OFFICIAL_TEMPLATES.find((item) => item.id === 'graduate-admission');
  const recruitment = OFFICIAL_TEMPLATES.find((item) => item.id === 'recruitment');
  assert.throws(()=>normalizeTemplate({...t, fields:[t.fields[0],t.fields[0]]}),/重复/);
  assert.throws(()=>normalizeTemplate({...t, fields:[{key:'__proto__',label:'bad'}]}),/无效/);
  assert.throws(()=>normalizeTemplate({...t, capabilities:['shell.execute']}),/不支持/);
  assert.throws(()=>importTemplate({...exportTemplate(t),schemaVersion:99}),/不.*支持/);
  assert.throws(()=>importTemplate(exportTemplate(recruitment)),/内置官方/);
});
