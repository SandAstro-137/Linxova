import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/lib/theme-provider";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserNav } from "@/components/user-nav";
import { OnboardingModal } from "@/components/OnboardingModal";
import { NotificationCenter } from "@/components/NotificationCenter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, Component, ErrorInfo, ReactNode } from "react";
import { TutorialModal } from "@/components/TutorialModal";
import { HelpCircle, AlertTriangle, ShieldAlert, LogOut, UserPlus, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("React Error Boundary caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-background p-4">
          <Card className="max-w-lg w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Something went wrong
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                An error occurred while loading this page. Please try refreshing.
              </p>
              <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-32">
                {this.state.error?.message}
              </pre>
              <Button onClick={() => window.location.reload()}>
                Refresh Page
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import JobsPage from "@/pages/jobs";
import JobDetailPage from "@/pages/job-detail";
import CreateJobPage from "@/pages/create-job";
import WalletPage from "@/pages/wallet";
import ProfilePage from "@/pages/profile";
import ModerationPage from "@/pages/moderation";
import PTOPage from "@/pages/pto";
import NotificationsPage from "@/pages/notifications";
import CurrentJobPage from "@/pages/current-job";
import MyJobsPage from "@/pages/my-jobs";
import RoleUpgradePage from "@/pages/role-upgrade";
import RoleUpgradeReviewPage from "@/pages/role-upgrade-review";
import AdminPage from "@/pages/admin";
import TeamManagementPage from "@/pages/team-management";
import MeetingsPage from "@/pages/meetings";
import MyDisputesPage from "@/pages/my-disputes";
import TeamRoomPage from "@/pages/team-room";
import MessagesPage from "@/pages/messages";
import SettingsPage from "@/pages/settings";
import VerifyEmailPage from "@/pages/verify-email";
import VaultPage from "@/pages/vault";
import FriendsPage from "@/pages/friends";
import MyApplicationsPage from "@/pages/my-applications";
import UserProfilePage from "@/pages/user-profile";
import JobInvitationsPage from "@/pages/job-invitations";
import IncomingRecommendationsPage from "@/pages/incoming-recommendations";
import LinoPage from "@/pages/lino";
import CalendarPage from "@/pages/calendar";
import logoLight from "@assets/logo-light.png";
import logoDark from "@assets/logo-dark.png";

function ProtectedRoute({ children, allowedRoles }: { children: React.ReactNode; allowedRoles?: string[] }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/" />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Redirect to="/dashboard" />;
  }

  return <>{children}</>;
}

function Router() {
  const { user } = useAuth();

  if (!user) {
    return (
      <Switch>
        <Route path="/" component={LoginPage} />
        <Route path="/verify-email" component={VerifyEmailPage} />
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard">
        <ProtectedRoute>
          <DashboardPage />
        </ProtectedRoute>
      </Route>
      <Route path="/jobs/create">
        <ProtectedRoute allowedRoles={["customer"]}>
          <CreateJobPage />
        </ProtectedRoute>
      </Route>
      <Route path="/jobs/:id">
        <ProtectedRoute>
          <JobDetailPage />
        </ProtectedRoute>
      </Route>
      <Route path="/jobs">
        <ProtectedRoute>
          <JobsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/wallet">
        <ProtectedRoute>
          <WalletPage />
        </ProtectedRoute>
      </Route>
      <Route path="/profile">
        <ProtectedRoute>
          <ProfilePage />
        </ProtectedRoute>
      </Route>
      <Route path="/current-job">
        <ProtectedRoute allowedRoles={["freelancer"]}>
          <CurrentJobPage />
        </ProtectedRoute>
      </Route>
      <Route path="/my-jobs">
        <ProtectedRoute allowedRoles={["customer"]}>
          <MyJobsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/moderation">
        <ProtectedRoute allowedRoles={["staff", "moderator", "head_of_moderation", "founder"]}>
          <ModerationPage />
        </ProtectedRoute>
      </Route>
      <Route path="/pto">
        <ProtectedRoute allowedRoles={["freelancer", "moderator", "head_of_moderation", "founder", "staff"]}>
          <PTOPage />
        </ProtectedRoute>
      </Route>
      <Route path="/notifications">
        <ProtectedRoute allowedRoles={["freelancer", "customer", "moderator", "head_of_moderation", "founder"]}>
          <NotificationsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/role-upgrade">
        <ProtectedRoute allowedRoles={["customer", "freelancer"]}>
          <RoleUpgradePage />
        </ProtectedRoute>
      </Route>
      <Route path="/role-upgrade-review">
        <ProtectedRoute allowedRoles={["moderator", "head_of_moderation", "founder"]}>
          <RoleUpgradeReviewPage />
        </ProtectedRoute>
      </Route>
      <Route path="/admin">
        <ProtectedRoute allowedRoles={["founder"]}>
          <AdminPage />
        </ProtectedRoute>
      </Route>
      <Route path="/team-management">
        <ProtectedRoute allowedRoles={["head_of_moderation", "founder"]}>
          <TeamManagementPage />
        </ProtectedRoute>
      </Route>
      <Route path="/meetings">
        <ProtectedRoute allowedRoles={["moderator", "head_of_moderation", "founder"]}>
          <MeetingsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/my-disputes">
        <ProtectedRoute allowedRoles={["moderator", "staff", "head_of_moderation", "founder"]}>
          <MyDisputesPage />
        </ProtectedRoute>
      </Route>
      <Route path="/team-room">
        <ProtectedRoute allowedRoles={["moderator", "head_of_moderation", "founder"]}>
          <TeamRoomPage />
        </ProtectedRoute>
      </Route>
      <Route path="/vault">
        <ProtectedRoute allowedRoles={["head_of_moderation", "founder"]}>
          <VaultPage />
        </ProtectedRoute>
      </Route>
      <Route path="/messages/:userId?">
        <ProtectedRoute>
          <MessagesPage />
        </ProtectedRoute>
      </Route>
      <Route path="/settings">
        <ProtectedRoute>
          <SettingsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/friends">
        <ProtectedRoute>
          <FriendsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/user/:id">
        <ProtectedRoute>
          <UserProfilePage />
        </ProtectedRoute>
      </Route>
      <Route path="/my-applications">
        <ProtectedRoute allowedRoles={["freelancer"]}>
          <MyApplicationsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/job-invitations">
        <ProtectedRoute allowedRoles={["freelancer"]}>
          <JobInvitationsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/incoming-recommendations">
        <ProtectedRoute allowedRoles={["customer"]}>
          <IncomingRecommendationsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/lino">
        <ProtectedRoute>
          <LinoPage />
        </ProtectedRoute>
      </Route>
      <Route path="/calendar">
        <ProtectedRoute allowedRoles={["moderator", "head_of_moderation", "founder"]}>
          <CalendarPage />
        </ProtectedRoute>
      </Route>
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function SuspendedScreen() {
  const { suspensionInfo, logout, clearSuspension, refetchUser } = useAuth();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  if (!suspensionInfo) return null;

  const suspendedUntil = new Date(suspensionInfo.suspendedUntil);
  const isExpired = suspendedUntil <= now;

  const formatTimeRemaining = () => {
    if (isExpired) return "Your suspension has expired. You may try logging in again.";
    const diff = suspendedUntil.getTime() - now.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const parts = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
    return parts.length > 0 ? parts.join(", ") + " remaining" : "Less than a minute remaining";
  };

  const handleSwitchAccount = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    clearSuspension();
    window.location.href = "/";
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto p-4 rounded-full bg-destructive/10 w-fit">
            <ShieldAlert className="h-10 w-10 text-destructive" />
          </div>
          <CardTitle className="text-xl" data-testid="text-suspended-title">Account Suspended</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="p-4 bg-muted/50 rounded-md space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">Suspension Lifts</p>
                  <p className="text-sm text-muted-foreground" data-testid="text-suspension-until">
                    {format(suspendedUntil, "MMMM d, yyyy 'at' h:mm a")} ET
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground" data-testid="text-suspension-remaining">
                {formatTimeRemaining()}
              </p>
            </div>

            {suspensionInfo.reason && (
              <div className="p-4 bg-muted/50 rounded-md">
                <p className="text-sm font-medium mb-1">Reason</p>
                <p className="text-sm text-muted-foreground" data-testid="text-suspension-reason">
                  {suspensionInfo.reason}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {isExpired && (
              <Button
                className="w-full gap-2"
                onClick={() => {
                  clearSuspension();
                  refetchUser();
                }}
                data-testid="button-try-login"
              >
                Try Logging In Again
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handleSwitchAccount}
              data-testid="button-switch-account"
            >
              <UserPlus className="h-4 w-4" />
              Switch Account
            </Button>
            <Button
              variant="ghost"
              className="w-full gap-2 text-muted-foreground"
              onClick={logout}
              data-testid="button-log-off"
            >
              <LogOut className="h-4 w-4" />
              Log Off
            </Button>
          </div>

          <p className="text-xs text-center text-muted-foreground">
            If you believe this was a mistake, please contact support after your suspension is lifted.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AppContent() {
  const { user, refetchUser, suspensionInfo } = useAuth();
  const { toast } = useToast();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    if (user && !user.onboardingCompleted) {
      setShowOnboarding(true);
    }
  }, [user]);

  const handleCompleteOnboarding = async () => {
    try {
      await apiRequest("POST", "/api/auth/complete-onboarding", {});
      setShowOnboarding(false);
      refetchUser();
      toast({
        title: "Welcome to Linxova!",
        description: "You're all set to get started.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to complete onboarding. Please try again.",
        variant: "destructive",
      });
    }
  };

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  if (suspensionInfo) {
    return <SuspendedScreen />;
  }

  if (!user) {
    return <Router />;
  }

  return (
    <>
      <SidebarProvider style={style as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar />
          <div className="flex flex-col flex-1 overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-4 p-4 border-b bg-background">
              <div className="flex flex-wrap items-center gap-4">
                <SidebarTrigger data-testid="button-sidebar-toggle" />
                <div className="flex flex-wrap items-center gap-2">
                  <img 
                    src={logoLight} 
                    alt="Linxova Logo" 
                    className="h-10 max-h-12 dark:hidden"
                    style={{ objectFit: "contain" }}
                    data-testid="img-logo-light"
                  />
                  <img 
                    src={logoDark} 
                    alt="Linxova Logo" 
                    className="h-10 max-h-12 hidden dark:block"
                    style={{ objectFit: "contain" }}
                    data-testid="img-logo-dark"
                  />
                  <span className="text-lg font-semibold" data-testid="text-app-name">Linxova</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowTutorial(true)}
                      data-testid="button-help"
                    >
                      <HelpCircle className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>View Tutorial</p>
                  </TooltipContent>
                </Tooltip>
                <NotificationCenter />
                <ThemeToggle />
                <UserNav />
              </div>
            </header>
            <main className="flex-1 overflow-y-auto p-6">
              <Router />
            </main>
          </div>
        </div>
      </SidebarProvider>
      <OnboardingModal
        user={user}
        open={showOnboarding}
        onComplete={handleCompleteOnboarding}
      />
      <TutorialModal
        open={showTutorial}
        onOpenChange={setShowTutorial}
      />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <TooltipProvider>
              <AppContent />
              <Toaster />
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
