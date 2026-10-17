import React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { PanelsTopLeft, Wrench } from 'lucide-react';
import { useWorkbenches } from '@/context/workbenches';
import { cn } from '@/lib/utils';
import {
  SidebarGroup, SidebarGroupLabel, SidebarGroupContent,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton,
} from '@/components/ui/sidebar';

export function WorkbenchSidebar() {
  const { visibleFeatures, visibleWorkbenches } = useWorkbenches();
  const location = useLocation();
  const managing = location.pathname === '/app/workbenches' && new URLSearchParams(location.search).get('adjust') === '1';
  const activeClass = ({ isActive }) => cn(isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground');

  return (
    <SidebarGroup data-tour="workbenches">
      <SidebarGroupLabel><Link to="/app/workbenches">我的工作台</Link></SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {visibleFeatures.map((feature) => (
            <SidebarMenuItem key={feature.id}>
              <SidebarMenuButton asChild tooltip={feature.name}>
                <NavLink to={feature.path} className={activeClass} data-tour={feature.id}>
                  <feature.icon /><span>{feature.name}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {visibleWorkbenches.map((workbench) => (
            <SidebarMenuItem key={workbench.id}>
              <SidebarMenuButton asChild tooltip={workbench.name}>
                <NavLink to={`/app/workbenches/${workbench.id}`} className={activeClass}>
                  <PanelsTopLeft /><span>{workbench.name}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="添加模板、显示或移除已添加的工作台" isActive={managing}>
              <Link to="/app/workbenches?adjust=1" data-tour="manage-workbench"><Wrench /><span>管理工作台</span></Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
