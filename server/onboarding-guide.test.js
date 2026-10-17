import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'work', 'onboarding-guide-'));
process.env.DAYLIGHT_DATA_DIR = directory;

const {
  DEFAULT_ONBOARDING_STEPS,
  filterStepsForAudience,
  readOnboardingGuideAsync,
  resetOnboardingGuide,
  saveOnboardingGuide,
} = await import('./onboarding-guide.js');

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('新手引导默认步骤可读写，旧 audience 不再限制用户（无 PG 时落 JSON）', async () => {
  const guide = await readOnboardingGuideAsync();
  assert.ok(guide.steps.length >= 8);
  assert.equal(guide.storage, 'file');
  assert.ok(guide.steps.some((step) => step.id === 'settings'));
  assert.ok(guide.steps.some((step) => step.id === 'workbenches' && step.path === '/app/workbenches' && step.audience === 'all'));
  assert.equal(guide.steps.some((step) => step.path === '/app/recruitment'), false);

  const personal = filterStepsForAudience(guide.steps, { hr: false });
  assert.equal(personal.some((step) => step.id === 'workbenches'), true);

  const hr = filterStepsForAudience(guide.steps, { hr: true });
  assert.ok(hr.some((step) => step.id === 'workbenches'));

  const saved = await saveOnboardingGuide({
    steps: [
      {
        id: 'welcome',
        title: '欢迎',
        text: '自定义第一步',
        tips: ['提示一'],
        path: '/app',
        selector: '[data-tour="overview"]',
        audience: 'all',
      },
    ],
  });
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.storage, 'file');
  assert.equal((await readOnboardingGuideAsync()).steps[0].title, '欢迎');

  const reset = await resetOnboardingGuide();
  assert.ok(reset.steps.length >= 8);
  assert.ok(fs.existsSync(path.join(directory, 'onboarding-guide.json')));
  await saveOnboardingGuide({
    steps: [{ id: 'recruitment', title: '旧入口', text: '旧', path: '/app/recruitment', selector: '[data-tour="recruitment"]', audience: 'hr' }],
  });
  const migrated = await readOnboardingGuideAsync();
  assert.equal(migrated.steps[0].id, 'workbenches');
  assert.equal(migrated.steps[0].path, '/app/workbenches');
  assert.equal(migrated.steps[0].selector, '[data-tour="workbenches"]');
});

test('已保存工作台引导只更新两版旧默认文案，自定义内容与其他步骤保留', async () => {
  const obsoleteTexts = [
    '从官方模板添加保研、申博、校招、投稿或智能招聘工作台。智能招聘的候选人、简历和邀约仍在对应工作台里使用，侧栏不再单独放入口。',
    '在「我的工作台」使用发票助手和场景工作台。点击「调整工作台」添加保研、申博、校招、投稿或智能招聘工作台，也可以隐藏暂时不用的功能。',
  ];
  const currentText = DEFAULT_ONBOARDING_STEPS.find((step) => step.id === 'workbenches').text;
  const original = {
    id: 'workbenches',
    audience: 'all',
    selector: '[data-tour="workbenches"]',
    path: '/app/workbenches',
    title: '保留自定义标题',
    tips: ['保留自定义提示'],
  };
  for (const text of obsoleteTexts) {
    const otherStep = { ...original, id: 'custom-workbench-guide', text };
    fs.writeFileSync(path.join(directory, 'onboarding-guide.json'), JSON.stringify({ steps: [{ ...original, text }, otherStep] }));
    const guide = await readOnboardingGuideAsync();
    assert.deepEqual(guide.steps, [{ ...original, text: currentText }, otherStep]);
  }
  const custom = { ...original, text: '先使用智能招聘工作台处理招聘邮件，再按自己的需要调整功能入口。' };
  await saveOnboardingGuide({ steps: [custom] });
  assert.deepEqual((await readOnboardingGuideAsync()).steps, [custom]);
});

test('小 D 旧默认引导更新为审核发信与会议能力，保留自定义引导', async () => {
  const current = DEFAULT_ONBOARDING_STEPS.find((step) => step.id === 'assistant');
  const legacy = { ...current,
    text: '右下角「小 D」打开后会列出当前能力：北京时间、日程、待办、已处理邮件和已入库简历。查询类提示可以直接试，写入类提示会先放进输入框。不能代发邮件，也不能创建飞书会议。',
    tips: ['需要已配置支持工具调用的模型', '支持语音输入（浏览器权限）', '设置里可改搜索快捷键'],
  };
  fs.writeFileSync(path.join(directory, 'onboarding-guide.json'), JSON.stringify({ steps: [legacy] }));
  assert.deepEqual((await readOnboardingGuideAsync()).steps[0], current);
  const custom = { ...current, text: '请先学习公司的邮件审核规则。', tips: ['自定义提示'] };
  await saveOnboardingGuide({ steps: [custom] });
  assert.deepEqual((await readOnboardingGuideAsync()).steps[0], custom);
});
