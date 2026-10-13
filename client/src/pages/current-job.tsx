import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MessageCircle, Send, Calendar, DollarSign, User, Briefcase, Users, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { Job, ChatMessage, TeamMessage } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

type EnrichedJob = Job & {
  customerUsername?: string;
  customerDiscordId?: string;
  collaboratorData?: Array<{
    id: string;
    username: string;
    avatar: string | null;
    specialization: string | null;
  }>;
  profitSplits?: Array<{
    userId: string;
    username: string;
    amount: number;
    percentage: number;
  }>;
};

export default function CurrentJobPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [teamMessage, setTeamMessage] = useState("");
  const [activeTab, setActiveTab] = useState("customer");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const teamMessagesEndRef = useRef<HTMLDivElement>(null);

  // Get freelancer's assigned jobs (includes claimed, in_progress, completed)
  const { data: freelancerJobs = [], isLoading: isLoadingJobs, isError, error } = useQuery<Job[]>({
    queryKey: ["/api/freelancer/jobs"],
  });


  // Active job statuses - jobs that are currently being worked on
  const activeJobStatuses = ["claimed", "in_progress", "submitted", "awaiting_customer"];

  // Find the current active job
  // The API already returns only jobs assigned to this user (primary, collaborator, or team member)
  // So we just need to find one with an active status
  const currentJob = freelancerJobs.find(
    (job) => activeJobStatuses.includes(job.status)
  );

  // Get enriched job details
  const { data: enrichedJob } = useQuery<EnrichedJob>({
    queryKey: ["/api/jobs", currentJob?.id],
    enabled: !!currentJob?.id,
  });

  // Get chat messages
  const { data: messages = [] } = useQuery<ChatMessage[]>({
    queryKey: ["/api/jobs", currentJob?.id, "chat"],
    enabled: !!currentJob?.id,
    refetchInterval: 3000, // Poll for new messages every 3 seconds
  });

  // Mark messages as read when viewing
  useEffect(() => {
    if (currentJob?.id && messages.length > 0) {
      const hasUnread = messages.some(msg => msg.receiverId === user?.id && !msg.read);
      if (hasUnread) {
        apiRequest("PUT", `/api/jobs/${currentJob.id}/chat/mark-read`, {})
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
            queryClient.invalidateQueries({ queryKey: ["/api/jobs", currentJob.id, "chat"] });
          })
          .catch((err) => {
            console.error("Failed to mark messages as read:", err);
          });
      }
    }
  }, [currentJob?.id, messages, user?.id]);

  const sendMessageMutation = useMutation({
    mutationFn: (text: string) =>
      apiRequest("POST", `/api/jobs/${currentJob?.id}/chat`, { message: text }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", currentJob?.id, "chat"] });
      setMessage("");
      toast({
        title: "Message sent",
        description: "Your message has been delivered",
      });
    },
    onError: () => {
      toast({
        title: "Failed to send message",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });

  // Get pending join requests (visible to primary freelancer)
  const isPrimaryFreelancer = currentJob && user && (currentJob as any).freelancerId === user.id;
  const { data: joinRequests = [] } = useQuery<any[]>({
    queryKey: ["/api/jobs", currentJob?.id, "requests"],
    enabled: !!currentJob?.id && isPrimaryFreelancer,
    refetchInterval: 15000,
  });
  const pendingJoinRequests = joinRequests.filter((r: any) => r.status === "pending");

  // Get team messages for freelancer-to-freelancer chat
  const { data: teamMessages = [] } = useQuery<TeamMessage[]>({
    queryKey: ["/api/jobs", currentJob?.id, "team-messages"],
    enabled: !!currentJob?.id,
    refetchInterval: 3000,
  });

  const sendTeamMessageMutation = useMutation({
    mutationFn: (text: string) =>
      apiRequest("POST", `/api/jobs/${currentJob?.id}/team-messages`, { 
        content: text 
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", currentJob?.id, "team-messages"] });
      setTeamMessage("");
    },
    onError: () => {
      toast({
        title: "Failed to send message",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    teamMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [teamMessages]);

  const handleSendMessage = () => {
    if (!message.trim()) return;
    sendMessageMutation.mutate(message.trim());
  };

  const handleSendTeamMessage = () => {
    if (!teamMessage.trim()) return;
    sendTeamMessageMutation.mutate(teamMessage.trim());
  };

  // Show loading state while fetching jobs
  if (isLoadingJobs) {
    return (
      <div className="container mx-auto p-6 max-w-4xl bg-background min-h-[50vh]">
        <Card data-testid="card-loading">
          <CardHeader>
            <CardTitle>Current Job</CardTitle>
            <CardDescription>Loading your current job...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show error state if query failed
  if (isError) {
    return (
      <div className="container mx-auto p-6 max-w-4xl bg-background min-h-[50vh]">
        <Card data-testid="card-error">
          <CardHeader>
            <CardTitle>Current Job</CardTitle>
            <CardDescription>Failed to load job data</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              There was an error loading your current job. Please try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!currentJob) {
    return (
      <div className="container mx-auto p-6 max-w-4xl bg-background min-h-[50vh]">
        <Card data-testid="card-no-current-job">
          <CardHeader>
            <CardTitle>Current Job</CardTitle>
            <CardDescription>You don't have any active job at the moment</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Browse available jobs in the marketplace to find your next project
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <h1 className="text-3xl font-bold mb-6" data-testid="text-page-title">
        Current Job
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Job Details */}
        <div className="lg:col-span-2 space-y-6">
          <Card data-testid="card-job-details">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle data-testid="text-job-title">{enrichedJob?.title || currentJob.title}</CardTitle>
                  <CardDescription className="mt-1">
                    {enrichedJob?.category || currentJob.category}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge data-testid={`badge-status-${currentJob.status}`}>
                    {currentJob.status}
                  </Badge>
                  <Link href={`/jobs/${currentJob.id}`}>
                    <Button variant="outline" size="sm" data-testid="button-view-job-details">
                      <ExternalLink className="w-4 h-4 mr-1" />
                      Actions
                    </Button>
                  </Link>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Description</h3>
                <p className="text-muted-foreground" data-testid="text-job-description">
                  {currentJob.description}
                </p>
              </div>

              {currentJob.requirements && (
                <div>
                  <h3 className="font-semibold mb-2">Requirements</h3>
                  <p className="text-muted-foreground" data-testid="text-job-requirements">
                    {currentJob.requirements}
                  </p>
                </div>
              )}

              <Separator />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Budget</p>
                    <p className="font-semibold" data-testid="text-job-budget">
                      ${currentJob.budget}
                    </p>
                  </div>
                </div>

                {currentJob.deadline && (
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Deadline</p>
                      <p className="font-semibold" data-testid="text-job-deadline">
                        {new Date(currentJob.deadline).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {enrichedJob?.profitSplits && enrichedJob.profitSplits.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <h3 className="font-semibold mb-1">Earnings Breakdown</h3>
                    <p className="text-xs text-muted-foreground mb-3">Estimated payout per team member</p>
                    <div className="space-y-3">
                      {enrichedJob.profitSplits.map((split) => {
                        const pct = Number(split.percentage || 0);
                        return (
                          <div
                            key={split.userId}
                            className="space-y-1"
                            data-testid={`profit-split-${split.userId}`}
                          >
                            <div className="flex items-center justify-between text-sm">
                              {(() => {
                                const collab = enrichedJob.collaboratorData?.find(c => c.id === split.userId);
                                const name = collab?.username || split.userId;
                                return (
                                  <Link href={`/user/${split.userId}`} className="font-medium hover:underline">
                                    {name}
                                  </Link>
                                );
                              })()}
                              <span className="text-muted-foreground">
                                ${Number(split.amount || 0).toFixed(2)} <span className="text-xs">({pct.toFixed(0)}%)</span>
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Chat Interface with Tabs */}
          <Card data-testid="card-chat-interface">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="w-5 h-5" />
                Communications
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="customer" className="flex items-center gap-2" data-testid="tab-customer-chat">
                    <User className="w-4 h-4" />
                    Customer Chat
                  </TabsTrigger>
                  <TabsTrigger value="team" className="flex items-center gap-2" data-testid="tab-team-chat">
                    <Users className="w-4 h-4" />
                    Team Discussion
                  </TabsTrigger>
                </TabsList>

                {/* Customer Chat Tab */}
                <TabsContent value="customer" className="mt-0">
                  <p className="text-sm text-muted-foreground mb-3">
                    {enrichedJob?.customerUsername && `Chatting with ${enrichedJob.customerUsername}`}
                  </p>
                  <div className="space-y-4 mb-4 max-h-80 overflow-y-auto" data-testid="chat-messages-container">
                    {messages.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">
                        No messages yet. Start the conversation!
                      </p>
                    ) : (
                      messages.map((msg) => {
                        const isSender = msg.senderId === user?.id;
                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isSender ? "justify-end" : "justify-start"}`}
                            data-testid={`message-${msg.id}`}
                          >
                            <div
                              className={`max-w-[70%] rounded-lg p-3 ${
                                isSender
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted"
                              }`}
                            >
                              <p className="text-sm">{msg.message}</p>
                              <p className="text-xs opacity-70 mt-1">
                                {formatDistanceToNow(new Date(msg.createdAt!), { addSuffix: true })}
                              </p>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Type your message..."
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                      data-testid="input-chat-message"
                    />
                    <Button
                      onClick={handleSendMessage}
                      disabled={!message.trim() || sendMessageMutation.isPending}
                      data-testid="button-send-message"
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </TabsContent>

                {/* Team Discussion Tab */}
                <TabsContent value="team" className="mt-0">
                  <p className="text-sm text-muted-foreground mb-3">
                    Private discussion between team members working on this job
                  </p>
                  <div className="space-y-4 mb-4 max-h-80 overflow-y-auto" data-testid="team-messages-container">
                    {teamMessages.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">
                        No team messages yet. Start coordinating with your team!
                      </p>
                    ) : (
                      teamMessages.map((msg) => {
                        const isSender = msg.senderId === user?.id;
                        const senderInfo = enrichedJob?.collaboratorData?.find(c => c.id === msg.senderId);
                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isSender ? "justify-end" : "justify-start"}`}
                            data-testid={`team-message-${msg.id}`}
                          >
                            <div className={`max-w-[70%] ${isSender ? "" : "flex gap-2"}`}>
                              {!isSender && (
                                <Avatar className="w-8 h-8 flex-shrink-0">
                                  <AvatarImage src={senderInfo?.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${msg.senderId}`} />
                                  <AvatarFallback>{senderInfo?.username?.[0]?.toUpperCase() || "T"}</AvatarFallback>
                                </Avatar>
                              )}
                              <div
                                className={`rounded-lg p-3 ${
                                  isSender
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted"
                                }`}
                              >
                                {!isSender && (
                                  <p className="text-xs font-medium mb-1">{senderInfo?.username || "Team Member"}</p>
                                )}
                                <p className="text-sm">{msg.content}</p>
                                <p className="text-xs opacity-70 mt-1">
                                  {formatDistanceToNow(new Date(msg.createdAt!), { addSuffix: true })}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={teamMessagesEndRef} />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Message your team..."
                      value={teamMessage}
                      onChange={(e) => setTeamMessage(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleSendTeamMessage()}
                      data-testid="input-team-message"
                    />
                    <Button
                      onClick={handleSendTeamMessage}
                      disabled={!teamMessage.trim() || sendTeamMessageMutation.isPending}
                      data-testid="button-send-team-message"
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card data-testid="card-customer-info">
            <CardHeader>
              <CardTitle className="text-lg">Customer</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 mb-4">
                <Avatar>
                  <AvatarImage src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${enrichedJob?.customerUsername}`} />
                  <AvatarFallback>
                    {enrichedJob?.customerUsername?.[0]?.toUpperCase() || "C"}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-semibold" data-testid="text-customer-username">
                    {enrichedJob?.customerUsername || "Customer"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {enrichedJob?.collaboratorData && enrichedJob.collaboratorData.length > 0 && (
            <Card data-testid="card-team-members">
              <CardHeader>
                <CardTitle className="text-lg">Team Members</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {enrichedJob.collaboratorData.map((collab) => (
                    <div
                      key={collab.id}
                      className="flex items-center gap-3"
                      data-testid={`team-member-${collab.id}`}
                    >
                      <Link href={`/user/${collab.id}`}>
                        <Avatar className="w-8 h-8 cursor-pointer">
                          <AvatarImage src={collab.avatar || undefined} />
                          <AvatarFallback>{collab.username[0].toUpperCase()}</AvatarFallback>
                        </Avatar>
                      </Link>
                      <div className="flex-1 min-w-0">
                        <Link href={`/user/${collab.id}`} className="text-sm font-medium hover:underline truncate block">
                          {collab.username}
                        </Link>
                        {collab.specialization && (
                          <p className="text-xs text-muted-foreground truncate">
                            {collab.specialization}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {isPrimaryFreelancer && pendingJoinRequests.length > 0 && (
            <Card data-testid="card-join-requests">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Team Join Requests
                  <Badge variant="secondary">{pendingJoinRequests.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  Manage join requests from your job page
                </p>
                <div className="space-y-3">
                  {pendingJoinRequests.map((request: any) => (
                    <div key={request.id} className="flex items-center gap-3" data-testid={`join-request-${request.id}`}>
                      <Avatar className="w-8 h-8">
                        <AvatarImage src={request.freelancer?.avatar || undefined} />
                        <AvatarFallback>
                          {request.freelancer?.username?.[0]?.toUpperCase() || "?"}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {request.freelancer?.username || "Freelancer"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Level {request.freelancer?.level || 1} &middot; {request.freelancer?.completedJobs || 0} jobs
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <Link href={`/jobs/${currentJob?.id}`}>
                  <Button variant="outline" size="sm" className="w-full mt-3" data-testid="button-manage-requests">
                    Manage Requests
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
