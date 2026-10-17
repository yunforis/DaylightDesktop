import React from 'react';
import {
  Award, BadgeCheck, BookOpen, Briefcase, ChevronDown, FolderKanban,
  GraduationCap, Info, Languages, Mail, MapPin, Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FIELD_NAMES, textOf } from '@/lib/recruitment';
import { cn } from '@/lib/utils';

function isFilled(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function asList(value) {
  if (!isFilled(value)) return [];
  return Array.isArray(value) ? value : [value];
}

function pickText(item, keys) {
  if (!item || typeof item !== 'object') return textOf(item);
  for (const key of keys) {
    if (isFilled(item[key])) return textOf(item[key]);
  }
  return '';
}

function periodOf(item) {
  if (!item || typeof item !== 'object') return '';
  const start = pickText(item, ['start', 'startDate', 'year', 'date', 'graduationYear']);
  const end = pickText(item, ['end', 'endDate', 'graduationDate']);
  if (start && end) return `${start} – ${end}`;
  return start || end || '';
}

function FieldScalar({ value }) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (!isFilled(value)) return <span className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('、') || '—';
  if (typeof value === 'object') return textOf(value) || '—';
  return String(value);
}

function KvGrid({ entries, cols = 2 }) {
  const rows = entries.filter(([, value]) => isFilled(value));
  if (!rows.length) return null;
  return (
    <dl className={cn('grid gap-x-4 gap-y-2.5 text-sm', cols === 2 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
      {rows.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {FIELD_NAMES[key] || key}
          </dt>
          <dd className="mt-0.5 break-words leading-snug text-foreground">
            <FieldScalar value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TimelineCard({ title, meta, subtitle, body, tags }) {
  return (
    <div className="relative pl-4 before:absolute before:bottom-2 before:left-[3px] before:top-2 before:w-px before:bg-border">
      <span className="absolute left-0 top-2 size-1.5 rounded-full bg-foreground/40" />
      <div className="space-y-1.5 rounded-xl border bg-background/80 px-3.5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h4 className="text-sm font-semibold leading-snug">{title || '未命名'}</h4>
          {meta ? <span className="text-[11px] tabular-nums text-muted-foreground">{meta}</span> : null}
        </div>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
        {body ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{body}</p> : null}
        {tags?.length ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SkillChips({ value }) {
  const chips = [];
  for (const item of asList(value)) {
    if (typeof item === 'string' || typeof item === 'number') {
      chips.push(String(item));
      continue;
    }
    if (item && typeof item === 'object') {
      const name = pickText(item, ['name', 'skill', 'label', 'title', 'technologies', 'skills']);
      const level = pickText(item, ['proficiency', 'level', 'score']);
      if (name) {
        chips.push(level ? `${name} · ${level}` : name);
      } else {
        const nested = item.technologies || item.skills || item.keywords;
        if (Array.isArray(nested)) chips.push(...nested.map(textOf).filter(Boolean));
        else if (isFilled(item)) chips.push(textOf(item));
      }
    }
  }
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip, index) => (
        <span
          key={`${chip}-${index}`}
          className="rounded-full border border-border/80 bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

function ProfileModule({ icon: Icon, title, children }) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/25 px-4 py-2.5">
        {Icon ? <Icon className="size-3.5 text-muted-foreground" /> : null}
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

function renderTimelineGroup(value, kind) {
  const items = asList(value);
  if (!items.length) return null;
  return (
    <div className="space-y-2.5">
      {items.map((item, index) => {
        if (typeof item !== 'object' || !item) {
          return <TimelineCard key={index} title={textOf(item)} />;
        }
        if (kind === 'education') {
          return (
            <TimelineCard
              key={index}
              title={pickText(item, ['school', 'schoolName', 'university', 'institution', 'name']) || '学校未提供'}
              meta={periodOf(item)}
              subtitle={[
                pickText(item, ['degree', 'education']),
                pickText(item, ['major', 'department', 'researchDirection']),
                pickText(item, ['city', 'schoolCity', 'campus', 'location']),
              ].filter(Boolean).join(' · ')}
              body={pickText(item, ['description', 'summary', 'thesis', 'thesisTitle', 'honors'])}
              tags={[
                ...(pickText(item, ['gpa']) ? [`GPA ${pickText(item, ['gpa'])}`] : []),
                ...(pickText(item, ['ranking', 'rank']) ? [`排名 ${pickText(item, ['ranking', 'rank'])}`] : []),
              ]}
            />
          );
        }
        if (kind === 'experience') {
          return (
            <TimelineCard
              key={index}
              title={pickText(item, ['title', 'position', 'jobTitle', 'role', 'name']) || '职位未提供'}
              meta={periodOf(item)}
              subtitle={[
                pickText(item, ['company', 'companyName', 'organization', 'institution', 'employer', 'institutionName']),
                pickText(item, ['city', 'location']),
                pickText(item, ['type', 'employmentType']),
              ].filter(Boolean).join(' · ')}
              body={pickText(item, ['description', 'responsibilities', 'achievements', 'summary', 'contribution'])}
              tags={asList(item.technologies || item.skills).map(textOf).filter(Boolean)}
            />
          );
        }
        if (kind === 'projects') {
          return (
            <TimelineCard
              key={index}
              title={pickText(item, ['name', 'project', 'projectName', 'title', 'label']) || '项目未提供'}
              meta={periodOf(item) || pickText(item, ['duration'])}
              subtitle={[
                pickText(item, ['role', 'position']),
                pickText(item, ['organization', 'company']),
              ].filter(Boolean).join(' · ')}
              body={pickText(item, ['description', 'summary', 'achievements', 'contribution', 'contributions'])}
              tags={asList(item.technologies || item.skills || item.keywords).map(textOf).filter(Boolean)}
            />
          );
        }
        if (kind === 'research') {
          return (
            <TimelineCard
              key={index}
              title={pickText(item, ['title', 'publication', 'name', 'thesisTitle', 'project']) || '科研条目'}
              meta={periodOf(item) || pickText(item, ['publicationDate', 'year'])}
              subtitle={[
                pickText(item, ['journal', 'venue']),
                pickText(item, ['authors']),
                pickText(item, ['role']),
              ].filter(Boolean).join(' · ')}
              body={pickText(item, ['description', 'summary', 'contribution', 'abstract'])}
              tags={[
                ...(pickText(item, ['doi']) ? [`DOI ${pickText(item, ['doi'])}`] : []),
                ...(pickText(item, ['url', 'link']) ? [pickText(item, ['url', 'link'])] : []),
              ]}
            />
          );
        }
        if (kind === 'awards') {
          return (
            <TimelineCard
              key={index}
              title={pickText(item, ['name', 'award', 'awardName', 'competition', 'competitionName', 'honor', 'title']) || '荣誉'}
              meta={periodOf(item) || pickText(item, ['date', 'year'])}
              subtitle={[
                pickText(item, ['level', 'awardLevel']),
                pickText(item, ['issuer', 'organization']),
                pickText(item, ['result']),
              ].filter(Boolean).join(' · ')}
              body={pickText(item, ['description', 'details', 'content'])}
            />
          );
        }
        return (
          <TimelineCard
            key={index}
            title={pickText(item, ['name', 'title', 'label', 'certificate', 'certificateName', 'language']) || textOf(item) || '条目'}
            meta={periodOf(item)}
            subtitle={pickText(item, ['issuer', 'proficiency', 'level', 'score', 'type'])}
            body={pickText(item, ['description', 'details', 'content', 'summary'])}
          />
        );
      })}
    </div>
  );
}

/** 候选人结构化简历：按模块聚合，时间线 + 标签，空模块折叠。 */
export function CandidateProfileModules({ profile = {} }) {
  const personal = profile.personal || {};
  const intent = profile.intent || {};
  const modules = [
    {
      key: 'education',
      title: '教育经历',
      icon: GraduationCap,
      span: true,
      render: () => renderTimelineGroup(profile.education, 'education'),
      empty: !isFilled(profile.education),
    },
    {
      key: 'experience',
      title: '工作与实习',
      icon: Briefcase,
      span: true,
      render: () => renderTimelineGroup(profile.experience, 'experience'),
      empty: !isFilled(profile.experience),
    },
    {
      key: 'projects',
      title: '项目经历',
      icon: FolderKanban,
      span: true,
      render: () => renderTimelineGroup(profile.projects, 'projects'),
      empty: !isFilled(profile.projects),
    },
    {
      key: 'research',
      title: '科研与论文',
      icon: BookOpen,
      span: true,
      render: () => renderTimelineGroup(profile.research, 'research'),
      empty: !isFilled(profile.research),
    },
    {
      key: 'awards',
      title: '竞赛与个人荣誉',
      icon: Award,
      span: false,
      render: () => renderTimelineGroup(profile.awards, 'awards'),
      empty: !isFilled(profile.awards),
    },
    {
      key: 'skills',
      title: '专业技能',
      icon: Wrench,
      span: false,
      render: () => <SkillChips value={profile.skills} />,
      empty: !isFilled(profile.skills),
    },
    {
      key: 'certificates',
      title: '资格证书',
      icon: BadgeCheck,
      span: false,
      render: () => renderTimelineGroup(profile.certificates, 'other'),
      empty: !isFilled(profile.certificates),
    },
    {
      key: 'languages',
      title: '语言能力',
      icon: Languages,
      span: false,
      render: () => renderTimelineGroup(profile.languages, 'other'),
      empty: !isFilled(profile.languages),
    },
    {
      key: 'other',
      title: '其他信息',
      icon: Info,
      span: true,
      render: () => {
        const value = profile.other;
        if (typeof value === 'string') {
          return <p className="whitespace-pre-wrap text-sm leading-relaxed">{value}</p>;
        }
        if (Array.isArray(value)) return renderTimelineGroup(value, 'other');
        if (value && typeof value === 'object') {
          return <KvGrid entries={Object.entries(value)} cols={1} />;
        }
        return null;
      },
      empty: !isFilled(profile.other),
    },
  ];

  const personalEntries = Object.entries(personal).filter(([key]) => key !== 'name');
  const intentEntries = Object.entries(intent);
  const filled = modules.filter((item) => !item.empty);
  const empty = modules.filter((item) => item.empty);

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border bg-gradient-to-br from-muted/50 via-background to-background">
        <div className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                候选人档案
              </p>
              <h3 className="text-xl font-semibold tracking-tight">{personal.name || '姓名未提供'}</h3>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {personal.email ? (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="size-3.5" />
                    {personal.email}
                  </span>
                ) : null}
                {personal.phone ? <span>{personal.phone}</span> : null}
                {personal.currentCity ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3.5" />
                    {personal.currentCity}
                  </span>
                ) : null}
              </div>
            </div>
            {(intent.positions || intent.cities || intent.expectedPosition || intent.expectedCity) ? (
              <div className="flex max-w-full flex-wrap gap-1.5">
                {asList(intent.positions || intent.expectedPosition).map((item) => (
                  <Badge key={`p-${textOf(item)}`} variant="secondary" className="rounded-full px-2.5">
                    {textOf(item)}
                  </Badge>
                ))}
                {asList(intent.cities || intent.expectedCity).map((item) => (
                  <Badge key={`c-${textOf(item)}`} variant="outline" className="rounded-full px-2.5">
                    {textOf(item)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-4 border-t border-border/60 pt-4 md:grid-cols-2">
            <div>
              <h4 className="mb-2.5 text-xs font-semibold text-muted-foreground">基本资料</h4>
              {personalEntries.length
                ? <KvGrid entries={personalEntries} />
                : <p className="text-sm text-muted-foreground">简历未提供</p>}
            </div>
            <div>
              <h4 className="mb-2.5 text-xs font-semibold text-muted-foreground">求职意向</h4>
              {intentEntries.length
                ? <KvGrid entries={intentEntries} />
                : <p className="text-sm text-muted-foreground">简历未提供</p>}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        {filled.map((item) => (
          <div key={item.key} className={cn(item.span && 'md:col-span-2')}>
            <ProfileModule icon={item.icon} title={item.title}>
              {item.render()}
            </ProfileModule>
          </div>
        ))}
      </div>

      {empty.length > 0 && (
        <details className="group rounded-2xl border bg-muted/15 open:bg-muted/25">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              未提供的模块（{empty.length}）
            </span>
          </summary>
          <div className="grid gap-2 px-4 pb-4 sm:grid-cols-2">
            {empty.map((item) => (
              <div
                key={item.key}
                className="rounded-xl border border-dashed bg-background/60 px-3 py-2.5 text-sm text-muted-foreground"
              >
                {item.title}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
