/** 招聘页共享工具（无 UI）。 */

export const EMPTY_RECRUITMENT = {
  candidates: [], attachments: [], messages: [], interviews: [], traces: [], busy: false,
};

export const isDemo = (item) => item?.demo || item?.source === 'demo' || item?.mode?.startsWith('demo');
export const nameOf = (candidate) => candidate?.profile?.personal?.name || '姓名未提供';
export const pdfUrl = (id, mailboxId) => (
  `/api/recruitment/attachments/${encodeURIComponent(id)}?mailbox=${encodeURIComponent(mailboxId || '')}`
);

export const textOf = (value) => (
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : Array.isArray(value)
      ? value.map(textOf).join('、')
      : value && typeof value === 'object'
        ? Object.values(value).map(textOf).join(' · ')
        : ''
);

export const dateTime = (value) => (
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(value))
    : '未设置时间'
);

export const toLocalTime = (value) => (
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(value)).replace(' ', 'T')
    : ''
);

export const toIso = (value) => (
  value ? `${value.length === 16 ? `${value}:00` : value}+08:00` : ''
);

export const FIELD_NAMES = {
  name: '姓名', email: '邮箱', phone: '手机', currentCity: '现居城市', birthDate: '出生日期',
  age: '简历注明年龄', gender: '性别', positions: '意向岗位', cities: '意向城市', salary: '期望薪资',
  availability: '到岗时间', school: '学校', schoolName: '学校', university: '学校', degree: '学历',
  education: '学历', major: '专业', city: '所在城市', schoolCity: '学校所在地', location: '所在地',
  start: '开始时间', end: '结束时间', startDate: '开始时间', endDate: '结束时间',
  graduationDate: '毕业时间', graduationYear: '毕业年份', graduated: '是否毕业', gpa: 'GPA',
  ranking: '排名', courses: '课程', company: '公司', organization: '机构', title: '名称 / 职位',
  position: '职位', role: '担任角色', type: '类型', description: '经历描述',
  responsibilities: '工作内容', achievements: '成果', technologies: '技术栈', skills: '技能',
  summary: '概述', project: '项目', projectName: '项目名称', duration: '时间', date: '日期',
  year: '年份', award: '奖项', level: '等级', issuer: '颁发机构', result: '成果',
  publication: '发表情况', journal: '期刊', authors: '作者', url: '链接', link: '链接',
  proficiency: '熟练程度', score: '成绩', details: '详情', content: '内容', status: '状态',
  label: '项目', value: '信息', institution: '机构', department: '院系 / 部门',
  researchDirection: '研究方向', supervisor: '导师', honors: '荣誉', keywords: '关键词',
  homepage: '个人主页', website: '个人网站', portfolio: '作品集', campus: '校区',
  graduationStatus: '毕业状态', rank: '排名', evidence: '简历依据', page: '页码',
  pageNumber: '页码', quote: '原文摘录', contribution: '个人贡献', contributions: '个人贡献',
  raw: '原始信息', rawText: '原文', employer: '任职单位', employmentType: '任职类型',
  jobTitle: '职位名称', thesis: '毕业论文', thesisTitle: '论文题目', researchArea: '研究领域',
  achievement: '成果', honor: '荣誉', competition: '竞赛', competitionName: '竞赛名称',
  awardName: '奖项名称', awardLevel: '获奖等级', certificate: '证书', certificateName: '证书名称',
  language: '语言', selfIntroduction: '自我介绍', selfEvaluation: '自我评价',
  expectedSalary: '期望薪资', expectedPosition: '意向岗位', expectedCity: '意向城市',
  availableFrom: '可到岗时间', institutionName: '机构名称', companyName: '公司名称',
  teamSize: '团队人数', patent: '专利', publicationDate: '发表日期', doi: '文献标识',
};

export const PROFILE_GROUPS = [
  ['personal', '基本资料'], ['intent', '求职意向'], ['education', '教育经历'],
  ['experience', '工作与实习'], ['projects', '项目经历'], ['research', '科研与论文'],
  ['awards', '竞赛与个人荣誉'], ['skills', '专业技能'], ['certificates', '资格证书'],
  ['languages', '语言能力'], ['other', '其他信息'],
];

export const CHAT_EXAMPLES = [
  '我想找做过云计算项目，在上海地区大学毕业的同学',
  '帮我看看人才库里有哪些候选人',
  '我想了解某位候选人的项目和实习经历',
];
