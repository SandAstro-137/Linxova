import { Home, Briefcase, Wallet, User, Shield, Clock, Bell, PlusCircle, ArrowUpCircle, Users, Crown, CalendarDays, Calendar, MessageCircle, MessageSquare, Settings, Vault, UserPlus, FileText, Mail, Gavel, Bug, Bot, Flag } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useAuth } from "@/lib/auth-context";
import { Badge } from "@/components/ui/badge";
import { ReportDialog } from "@/components/ReportDialog";
import logoLight from "@assets/logo-light.png";
import logoDark from "@assets/logo-dark.png";

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const [bugReportOpen, setBugReportOpen] = useState(false);

  // Fetch unread notification count for all roles
  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    enabled: !!user,
    refetchInterval: 5000, // Poll every 5 seconds
  });
  const unreadCount = unreadData?.count ?? 0;

  const freelancerItems = [
    { title: "Dashboard", url: "/dashboard", icon: Home },
    { title: "Messages", url: "/messages", icon: MessageSquare },
    { title: "Friends", url: "/friends", icon: UserPlus },
    { title: "Current Job", url: "/current-job", icon: Briefcase },
    { title: "My Applications", url: "/my-applications", icon: FileText },
    { title: "Job Invitations", url: "/job-invitations", icon: Mail },
    { title: "Browse Jobs", url: "/jobs", icon: Briefcase },
    { title: "My Wallet", url: "/wallet", icon: Wallet },
    { title: "My Profile", url: "/profile", icon: User },
    { title: "Notifications", url: "/notifications", icon: Bell },
    { title: "Role Upgrade", url: "/role-upgrade", icon: ArrowUpCircle },
    { title: "Settings", url: "/settings", icon: Settings },
  ];

  const customerItems = [
    { title: "Dashboard", url: "/dashboard", icon: Home },
    { title: "Messages", url: "/messages", icon: MessageSquare },
    { title: "Friends", url: "/friends", icon: UserPlus },
    { title: "Post New Job", url: "/jobs/create", icon: PlusCircle },
    { title: "My Jobs", url: "/my-jobs", icon: Briefcase },
    { title: "Recommendations", url: "/incoming-recommendations", icon: Mail },
    { title: "Browse Jobs", url: "/jobs", icon: Briefcase },
    { title: "My Wallet", url: "/wallet", icon: Wallet },
    { title: "My Profile", url: "/profile", icon: User },
    { title: "Notifications", url: "/notifications", icon: Bell },
    { title: "Role Upgrade", url: "/role-upgrade", icon: ArrowUpCircle },
    { title: "Settings", url: "/settings", icon: Settings },
  ];

  const staffItems = [
    { title: "Dashboard", url: "/dashboard", icon: Home },
    { title: "Messages", url: "/messages", icon: MessageSquare },
    { title: "Friends", url: "/friends", icon: UserPlus },
    { title: "Team Room", url: "/team-room", icon: MessageCircle },
    { title: "Moderation Queue", url: "/moderation", icon: Shield },
    { title: "Calendar", url: "/calendar", icon: Calendar },
    { title: "My Disputes", url: "/my-disputes", icon: Gavel },
    { title: "Upgrade Requests", url: "/role-upgrade-review", icon: Users },
    { title: "My Meetings", url: "/meetings", icon: CalendarDays },
    { title: "PTO Requests", url: "/pto", icon: Clock },
    { title: "All Jobs", url: "/jobs", icon: Briefcase },
    { title: "Mod Wallet", url: "/wallet", icon: Wallet },
    { title: "My Profile", url: "/profile", icon: User },
    { title: "Notifications", url: "/notifications", icon: Bell },
    { title: "Settings", url: "/settings", icon: Settings },
  ];

  const headOfModerationItems = [
    { title: "Dashboard", url: "/dashboard", icon: Home },
    { title: "Messages", url: "/messages", icon: MessageSquare },
    { title: "Friends", url: "/friends", icon: UserPlus },
    { title: "Team Room", url: "/team-room", icon: MessageCircle },
    { title: "Team Management", url: "/team-management", icon: Users },
    { title: "Team Vault", url: "/vault", icon: Vault },
    { title: "My Meetings", url: "/meetings", icon: CalendarDays },
    { title: "Calendar", url: "/calendar", icon: Calendar },
    { title: "PTO Requests", url: "/pto", icon: Clock },
    { title: "Moderation Queue", url: "/moderation", icon: Shield },
    { title: "My Disputes", url: "/my-disputes", icon: Gavel },
    { title: "Upgrade Requests", url: "/role-upgrade-review", icon: Users },
    { title: "All Jobs", url: "/jobs", icon: Briefcase },
    { title: "My Wallet", url: "/wallet", icon: Wallet },
    { title: "My Profile", url: "/profile", icon: User },
    { title: "Notifications", url: "/notifications", icon: Bell },
    { title: "Settings", url: "/settings", icon: Settings },
  ];

  const founderItems = [
    { title: "Dashboard", url: "/dashboard", icon: Home },
    { title: "Messages", url: "/messages", icon: MessageSquare },
    { title: "Friends", url: "/friends", icon: UserPlus },
    { title: "Team Room", url: "/team-room", icon: MessageCircle },
    { title: "Admin Panel", url: "/admin", icon: Crown },
    { title: "Team Management", url: "/team-management", icon: Users },
    { title: "Team Vault", url: "/vault", icon: Vault },
    { title: "My Meetings", url: "/meetings", icon: CalendarDays },
    { title: "Calendar", url: "/calendar", icon: Calendar },
    { title: "Moderation Queue", url: "/moderation", icon: Shield },
    { title: "My Disputes", url: "/my-disputes", icon: Gavel },
    { title: "Upgrade Requests", url: "/role-upgrade-review", icon: Users },
    { title: "All Jobs", url: "/jobs", icon: Briefcase },
    { title: "My Wallet", url: "/wallet", icon: Wallet },
    { title: "My Profile", url: "/profile", icon: User },
    { title: "Notifications", url: "/notifications", icon: Bell },
    { title: "Settings", url: "/settings", icon: Settings },
  ];

  const getMenuItems = () => {
    if (user?.role === "founder") {
      return founderItems;
    }
    if (user?.role === "head_of_moderation") {
      return headOfModerationItems;
    }
    if (user?.role === "moderator" || user?.role === "staff") {
      return staffItems;
    }
    if (user?.role === "customer") {
      return customerItems;
    }
    return freelancerItems;
  };

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-2 px-2 py-4">
            <img 
              src={logoLight} 
              alt="Linxova" 
              className="w-6 h-6 dark:hidden"
            />
            <img 
              src={logoDark} 
              alt="Linxova" 
              className="w-6 h-6 hidden dark:block"
            />
            <span className="text-lg font-bold text-primary">Linxova</span>
            {user && (
              <Badge variant="secondary" className="ml-auto text-xs">
                {user.role}
              </Badge>
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {getMenuItems().map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url} data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                    <Link href={item.url}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                      {item.title === "Notifications" && unreadCount > 0 && (
                        <Badge variant="destructive" className="ml-auto text-xs" data-testid="badge-unread-count">
                          {unreadCount}
                        </Badge>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Support</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location === "/lino"} data-testid="link-ask-lino">
                  <Link href="/lino">
                    <Bot className="w-4 h-4" />
                    <span>Ask Lino</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setBugReportOpen(true)} data-testid="link-report-bug">
                  <Flag className="w-4 h-4" />
                  <span>Submit a Report</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <ReportDialog
        open={bugReportOpen}
        onOpenChange={setBugReportOpen}
        targetId="platform"
        reportType="bug"
        targetName="Linxova Platform"
        allowTypeSelection
      />
    </Sidebar>
  );
}
