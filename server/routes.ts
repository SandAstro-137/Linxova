import type { Express } from "express";
import { createServer, type Server } from "http";
import { randomBytes, randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { storage, type CalendarEvent } from "./storage";
import { requireAuth, requireRole } from "./middleware/auth";
import { insertJobSchema, insertPTORequestSchema, insertInvitationSchema, insertCancellationRequestSchema, getLevelPayout, getLevelFromEarnings, workingHoursSchema, insertTeamNoteSchema, insertTeamTaskSchema, insertTeamMessageSchema, insertRatingSchema, insertCustomerRatingSchema, insertRoleUpgradeRequestSchema, RoleUpgradeStatus, RoleUpgradeType, UserRole, insertReportSchema, ReportStatus, insertModeratorTaskSchema, ModeratorTaskStatus, ModeratorTaskType, insertModeratorMeetingSchema, insertMeetingRsvpSchema, MeetingRsvpStatus, insertTeamRoomMessageSchema, JobStatus, EscrowStatus, ScheduledTaskStatus, DisputeStatus, insertJobSubmissionSchema, JobSubmissionStatus, insertLeadershipVoteSchema, insertLeadershipVoteCastSchema, insertMeetingSchema, LeadershipVoteStatus, LeadershipVoteChoice, MeetingStatus, AbandonStatus } from "@shared/schema";
import { getCryptoPrices } from "./lib/coingecko";
import { getCryptoPriceService } from "./lib/crypto-price-ws";
import { filterContent, sanitizeText, isSpamLike } from "./lib/content-filter";
import { z } from "zod";
import OpenAI from "openai";

const uploadedFiles = new Map<string, string>();

// Team Room client tracking (moved here for scope visibility in API routes)
interface TeamRoomClient {
  id: string;
  ws: any;
  userId: string;
  username: string;
  avatar: string | null;
  role: string;
}

const teamRoomClients = new Map<string, TeamRoomClient>();

// All live connections for a user (a user may have several tabs open).
function getTeamRoomClientsForUser(userId: string): TeamRoomClient[] {
  const result: TeamRoomClient[] = [];
  teamRoomClients.forEach((client) => {
    if (client.userId === userId) result.push(client);
  });
  return result;
}

// Active team room voice calls - server-authoritative list so every member sees
// the same set of concurrent calls. A call is only removed when all participants
// leave, or when a founder/head of moderation explicitly closes it.
interface TeamRoomCall {
  id: string;
  initiatorId: string;
  initiatorUsername: string;
  participants: Set<string>;
  createdAt: number;
}
const teamRoomCalls = new Map<string, TeamRoomCall>();

// Team Room WebSocket tokens - short-lived tokens for secure WS authentication
interface TeamRoomToken {
  userId: string;
  expiresAt: number;
}

const teamRoomTokens = new Map<string, TeamRoomToken>();
const linoMemory = new Map<string, string[]>();

function recordLinoMemory(userId: string, message: string) {
  if (!message) return;
  const cleaned = message.trim();
  if (!cleaned) return;

  const history = linoMemory.get(userId) || [];
  if (history[history.length - 1] !== cleaned) {
    history.push(cleaned);
    if (history.length > 50) {
      history.shift();
    }
    linoMemory.set(userId, history);
  }
}

function getLinoMemoryTopics(userId: string) {
  const history = linoMemory.get(userId) || [];
  const text = history.join(" ").toLowerCase();
  const topics = new Set<string>();

  const topicMap: Record<string, string[]> = {
    wallet: ["wallet", "payment", "deposit", "withdraw", "escrow"],
    job: ["job", "jobs", "freelancer", "customer", "application", "submit", "approval", "claim", "in progress"],
    moderation: ["moderator", "report", "dispute", "review", "approval", "reject"],
    profile: ["profile", "role", "level", "rating", "account"],
    team: ["team", "friend", "group", "collaborat", "chat"],
    notifications: ["notification", "alert", "message", "unread"],
    support: ["support", "bug", "issue"],
  };

  for (const [topic, phrases] of Object.entries(topicMap)) {
    if (phrases.some((phrase) => text.includes(phrase))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function getLinoFallbackReply(recentMessages: Array<{ role: string; content: string }>, userId: string) {
  const lastMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].content.trim() : "";
  const normalized = lastMessage.toLowerCase();
  const memoryTopics = getLinoMemoryTopics(userId);

  const isGreeting = ["hi", "hello", "hey", "yo", "good morning", "good afternoon", "good evening"].some((g) => normalized === g || normalized.startsWith(`${g} `));
  const mentionsJob = /(job|jobs|freelancer|customer|apply|claim|browse|listing|hire|work)/.test(normalized);
  const mentionsWallet = /(wallet|payment|deposit|withdraw|escrow|balance|funds|usd)/.test(normalized);
  const mentionsModeration = /(moderator|moderation|report|dispute|approval|reject|review)/.test(normalized);
  const mentionsProfile = /(profile|role|level|rating|account|username|avatar)/.test(normalized);
  const mentionsNotifications = /(notification|alert|message|unread|update|notice)/.test(normalized);
  const mentionsTeam = /(team|group|collaborat|friend|invite|chat)/.test(normalized);
  const mentionsSupport = /(support|bug|issue|help|question)/.test(normalized);
  const isQuestion = lastMessage.endsWith("?") || /\b(what|where|how|why|when|who|which|can|could|should|would|do I|do you|help|find)\b/.test(normalized);

  if (isGreeting && lastMessage.length <= 30) {
    return "Hello! I’m Lino, your Linxova support assistant. How can I help you with jobs, wallet, moderation, profiles, or notifications today?";
  }

  if (!lastMessage) {
    return "I can help you with Linxova jobs, wallet, moderation, profiles, notifications, and team collaboration. What would you like to know?";
  }

  if (normalized.includes("ai integration") || normalized.includes("openai") || normalized.includes("api key") || normalized.includes("configured")) {
    return "AI integration is not available right now, but I can still help you understand how Linxova works.";
  }

  if (mentionsJob) {
    if (normalized.includes("where do i go") || normalized.includes("how do i find") || normalized.includes("where can i") || normalized.includes("get a job") || normalized.includes("find a job") || normalized.includes("apply for a job")) {
      return "To find a job on Linxova, open the Jobs page. Customers post jobs there, and freelancers can browse open listings, apply, or claim work depending on job settings.";
    }
    if (memoryTopics.includes("wallet") || mentionsWallet) {
      return "Jobs on Linxova are funded from your wallet and held in escrow until completion. Use the Jobs page to locate work and make sure your wallet balance is sufficient.";
    }
    return "Jobs on Linxova are posted by customers and claimed by freelancers. Use the Jobs page to browse open jobs, apply where allowed, and complete work with moderation support.";
  }

  if (mentionsWallet) {
    if (normalized.includes("where can i see my wallet") || normalized.includes("how do i deposit") || normalized.includes("how do i withdraw")) {
      return "Your wallet is available in the Wallet section. You can view your balance, deposit funds, withdraw funds, and see escrow transactions for active jobs.";
    }
    return "Your wallet stores USD funds used to pay for jobs and receive earnings. Linxova keeps job payments in escrow until the work is completed.";
  }

  if (mentionsModeration) {
    return "Moderators on Linxova review job work, handle disputes, and approve or reject submissions. Use the moderation tools and notifications to follow up on reports and review status.";
  }

  if (mentionsProfile) {
    return "Your profile shows your role, level, rating, and account details. Higher ratings and completed work help your visibility and payout on Linxova.";
  }

  if (mentionsNotifications) {
    return "Notifications show job updates, messages, and alerts. Check the Notifications page to stay informed about new activity and unread items.";
  }

  if (mentionsTeam) {
    return "Team collaboration helps you work with friends or groups on jobs. Use the team features to invite collaborators, coordinate work, and manage shared tasks.";
  }

  if (mentionsSupport || isQuestion) {
    return `I understand you asked: "${lastMessage.slice(0, 120)}". On Linxova, you can ask me about jobs, wallet, moderation, profiles, notifications, or team collaboration and I’ll guide you to the right section.`;
  }

  return `I understand you asked: "${lastMessage.slice(0, 120)}". I can help with Linxova jobs, wallet, moderation, profiles, notifications, and team collaboration. What would you like to know?`;
}

function generateTeamRoomToken(userId: string): string {
  // Use cryptographically strong random token
  const token = randomBytes(32).toString("hex");
  teamRoomTokens.set(token, {
    userId,
    expiresAt: Date.now() + 60000 // Token valid for 60 seconds
  });
  // Clean up old expired tokens to prevent unbounded Map growth
  Array.from(teamRoomTokens.entries()).forEach(([key, data]) => {
    if (Date.now() > data.expiresAt) {
      teamRoomTokens.delete(key);
    }
  });
  return token;
}

function validateTeamRoomToken(token: string): string | null {
  const tokenData = teamRoomTokens.get(token);
  if (!tokenData) return null;
  
  // Delete token after use (one-time use)
  teamRoomTokens.delete(token);
  
  // Check if expired
  if (Date.now() > tokenData.expiresAt) return null;
  
  return tokenData.userId;
}

// All freelancers working on a job (lead + collaborators + jobFreelancers), deduped.
async function getJobFreelancerIds(job: any): Promise<string[]> {
  const ids = new Set<string>();
  if (job.freelancerId) ids.add(job.freelancerId);
  if (job.collaborators) {
    for (const id of job.collaborators) ids.add(id);
  }
  const jobFreelancerRecords = await storage.getJobFreelancers(job.id);
  for (const jf of jobFreelancerRecords) ids.add(jf.freelancerId);
  return Array.from(ids);
}

// Aggregate view of the active leadership vote (anonymous — never exposes who voted what).
async function getActiveLeadershipVoteEnriched(job: any, currentUserId?: string) {
  const vote = await storage.getActiveLeadershipVoteByJob(job.id);
  if (!vote) return null;
  const candidate = await storage.getUser(vote.candidateId);
  const casts = await storage.getLeadershipVoteCasts(vote.id);
  const totalEligible = (await getJobFreelancerIds(job)).length;
  const agreeCount = casts.filter(c => c.choice === LeadershipVoteChoice.AGREE).length;
  const disapproveCount = casts.filter(c => c.choice === LeadershipVoteChoice.DISAPPROVE).length;
  const myCast = currentUserId ? casts.find(c => c.voterId === currentUserId) : undefined;
  return {
    id: vote.id,
    jobId: vote.jobId,
    candidateId: vote.candidateId,
    candidateUsername: candidate?.username || "Unknown",
    status: vote.status,
    agreeCount,
    disapproveCount,
    totalEligible,
    hasVoted: !!myCast,
    myChoice: myCast?.choice || null,
  };
}

// Move USDT from one user's wallet to another's. Returns { error, status } on failure.
async function performUsdtTransfer(fromUserId: string, toUserId: string, amount: number): Promise<{ error?: string; status?: number }> {
  const fromWallet = await storage.getWallet(fromUserId);
  if (!fromWallet) return { error: "Sender wallet not found", status: 404 };

  let toWallet = await storage.getWallet(toUserId);
  if (!toWallet) {
    toWallet = await storage.createWallet({
      userId: toUserId,
      walletAddress: `0x${Math.random().toString(36).substring(2, 15)}`,
    });
  }

  const total = parseFloat(fromWallet.usdtBalance || "0");
  const pending = parseFloat(fromWallet.pendingUsdtBalance || "0");
  const available = total - pending;
  if (available < amount) {
    return {
      error: `Insufficient available balance ($${available.toFixed(2)} available, $${pending.toFixed(2)} locked)`,
      status: 400,
    };
  }

  await storage.updateWallet(fromUserId, { usdtBalance: (total - amount).toString() });
  const toTotal = parseFloat(toWallet.usdtBalance || "0");
  await storage.updateWallet(toUserId, { usdtBalance: (toTotal + amount).toString() });

  const hash = `0x${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  await storage.createTransaction({
    walletId: fromWallet.id,
    type: "transfer_out",
    currency: "USDT",
    amount: amount.toString(),
    usdAmount: amount.toFixed(2),
    status: "completed",
    transactionHash: hash,
  });
  await storage.createTransaction({
    walletId: toWallet.id,
    type: "transfer_in",
    currency: "USDT",
    amount: amount.toString(),
    usdAmount: amount.toFixed(2),
    status: "completed",
    transactionHash: hash,
  });

  return {};
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    userRole?: string;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Dev/demo: per-tab demo identity. The session cookie is shared across all
  // tabs of a browser, so logging into a different demo account in another tab
  // silently rewrites the shared session. Each tab remembers its chosen demo
  // account in sessionStorage and sends it as X-Demo-User on every request; we
  // honor that header (development only) so two demo accounts can run side by
  // side in two tabs. Real (Discord) sessions are unaffected.
  app.use(async (req, res, next) => {
    const demoId = req.headers['x-demo-user'];
    if (typeof demoId === 'string' && demoId && process.env.NODE_ENV !== 'production') {
      try {
        const demoUser = await storage.getUserByDiscordId(demoId);
        if (demoUser) {
          req.session.userId = demoUser.id;
          req.session.userRole = demoUser.role;
        }
      } catch {
        // Fall back to the session identity
      }
    }
    next();
  });

  // Development: Simple login for testing (remove in production)
  app.post("/api/auth/dev-login", async (req, res) => {
    try {
      const { discordId } = req.body;
      let user = await storage.getUserByDiscordId(discordId);
      
      if (!user) {
        // Create demo user
        const getRoleAndName = (id: string) => {
          if (id.includes('founder')) return { role: 'founder', name: 'Demo Founder' };
          if (id.includes('head-mod')) return { role: 'head_of_moderation', name: 'Demo Head of Moderation' };
          if (id.includes('moderator')) return { role: 'moderator', name: 'Demo Moderator' };
          if (id.includes('customer')) return { role: 'customer', name: 'Demo Customer' };
          if (id.includes('freelancer')) return { role: 'freelancer', name: 'Demo Freelancer' };
          return { role: 'freelancer', name: 'Demo User' };
        };
        const { role, name } = getRoleAndName(discordId);
        user = await storage.createUser({
          discordId,
          username: name,
          role,
          email: `${discordId}@demo.com`,
        }, role === 'founder');
        
        // Create wallet for user
        await storage.createWallet({
          userId: user.id,
          walletAddress: `0x${Math.random().toString(36).substring(2, 15)}`,
        });
      }
      
      // Check account status before allowing login
      if (user.accountStatus === 'banned') {
        return res.status(403).json({ 
          error: 'Your account has been permanently banned.',
          accountStatus: 'banned'
        });
      }
      if (user.accountStatus === 'suspended' && user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
        return res.status(403).json({ 
          error: `Your account is suspended until ${new Date(user.suspendedUntil).toLocaleDateString()}`,
          accountStatus: 'suspended',
          suspendedUntil: user.suspendedUntil,
          reason: user.suspendedReason
        });
      }
      // If suspension has expired, clear it
      if (user.accountStatus === 'suspended' && user.suspendedUntil && new Date(user.suspendedUntil) <= new Date()) {
        user = (await storage.updateUser(user.id, { 
          accountStatus: 'active', 
          suspendedUntil: null, 
          suspendedReason: null 
        }))!;
      }

      req.session.userId = user.id;
      req.session.userRole = user.role;
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      // Never let the browser cache this: profile edits refetch it and must
      // see the freshly saved values immediately.
      res.set("Cache-Control", "no-store");
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Presence heartbeat: keeps lastActive fresh while a tab is open so the
  // online dot stays green. The requireAuth middleware throttles the write.
  app.post("/api/heartbeat", requireAuth, async (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/auth/demo-accounts", async (_req, res) => {
    try {
      const demoIds = ["demo-freelancer-1", "demo-freelancer-2", "demo-customer-1", "demo-moderator-1", "demo-head-mod-1", "demo-founder-1"];
      const accounts = [];
      for (const discordId of demoIds) {
        const user = await storage.getUserByDiscordId(discordId);
        if (user) {
          accounts.push({ id: user.discordId, username: user.username, role: user.role, avatar: user.avatar });
        }
      }
      res.json(accounts);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // Mark onboarding as completed
  app.post("/api/auth/complete-onboarding", requireAuth, async (req, res) => {
    try {
      const user = await storage.updateUser(req.session.userId!, {
        onboardingCompleted: true,
      });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(user);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dashboard stats
  app.get("/api/dashboard/stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const stats: any = {};

      if (user.role === "freelancer") {
        // Active job statuses for freelancers - jobs currently being worked on
        const activeStatuses = ["claimed", "in_progress", "submitted", "awaiting_customer"];
        const allFreelancerJobs = await storage.getJobs({ freelancerId: user.id });
        
        // Also count jobs from jobFreelancers table (multi-freelancer assignments)
        const freelancerAssignments = await storage.getJobFreelancersByFreelancer(user.id);
        const assignedJobIds = new Set(freelancerAssignments.map(jf => jf.jobId));
        const allJobs = await storage.getJobs({});
        const assignedJobs = allJobs.filter(j => assignedJobIds.has(j.id) && j.freelancerId !== user.id);
        
        // Combine primary jobs and assigned jobs, avoiding duplicates
        const combinedJobs = [...allFreelancerJobs, ...assignedJobs];
        stats.activeJobs = combinedJobs.filter(j => activeStatuses.includes(j.status)).length;
      } else if (user.role === "customer") {
        const allJobs = await storage.getJobs({ customerId: user.id });
        stats.postedJobs = allJobs.length;
        // Customer's active jobs include: open for applications, claimed, and in progress
        stats.activeJobs = allJobs.filter(j => 
          ["active", "claimed", "in_progress", "submitted", "awaiting_customer"].includes(j.status)
        ).length;
        stats.pendingJobs = allJobs.filter(j => j.status === "pending").length;
        stats.totalSpent = allJobs.reduce((sum, j) => sum + parseFloat(j.budget) + parseFloat(j.premiumAmount || "0"), 0).toFixed(2);
      } else if (user.role === "staff" || user.role === "moderator") {
        const pendingJobs = await storage.getJobsByStatus("pending");
        const allJobs = await storage.getJobs();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        stats.pendingJobs = pendingJobs.length;
        stats.totalJobs = allJobs.length;
        stats.activeJobs = allJobs.filter(j => j.status === "active").length;
        stats.approvedToday = allJobs.filter(j => 
          j.status === "active" && 
          j.updatedAt && 
          new Date(j.updatedAt) >= today
        ).length;
      } else if (user.role === "head_of_moderation") {
        const allUsers = await storage.getUsers();
        const pendingJobs = await storage.getJobsByStatus("pending");
        const allJobs = await storage.getJobs();
        const reports = await storage.getReports();
        const upgradeRequests = await storage.getRoleUpgradeRequests();
        
        // Count team members (moderators + staff)
        stats.teamMembers = allUsers.filter(u => 
          u.role === "moderator" || u.role === "staff"
        ).length;
        stats.pendingReports = reports.filter(r => r.status === "pending").length;
        stats.upgradeRequests = upgradeRequests.filter(r => r.status === "pending").length;
        stats.pendingJobs = pendingJobs.length;
        stats.totalJobs = allJobs.length;
        stats.activeJobs = allJobs.filter(j => j.status === "active").length;
      } else if (user.role === "founder") {
        const allUsers = await storage.getUsers();
        const allJobs = await storage.getJobs();
        
        stats.totalUsers = allUsers.length;
        stats.totalJobs = allJobs.length;
        stats.activeJobs = allJobs.filter(j => 
          j.status === "active" || j.status === "in_progress" || j.status === "claimed"
        ).length;
        // Calculate platform revenue from completed jobs
        const completedJobs = allJobs.filter(j => j.status === "completed");
        stats.platformRevenue = completedJobs.reduce((sum, j) => sum + parseFloat(j.budget), 0).toFixed(2);
      }

      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Levenshtein distance for fuzzy matching (typo tolerance)
  function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    
    return matrix[b.length][a.length];
  }
  
  // Fuzzy match check (returns true if strings are similar enough)
  function fuzzyMatch(search: string, target: string, threshold: number = 0.7): boolean {
    search = search.toLowerCase();
    target = target.toLowerCase();
    
    // Exact match or substring match
    if (target.includes(search) || search.includes(target)) {
      return true;
    }
    
    // Check if search starts with target or vice versa (partial word matching)
    if (target.startsWith(search) || search.startsWith(target)) {
      return true;
    }
    
    // Levenshtein distance for typo tolerance
    const distance = levenshteinDistance(search, target);
    const maxLength = Math.max(search.length, target.length);
    const similarity = 1 - (distance / maxLength);
    
    return similarity >= threshold;
  }

  // Synonym mapping for smarter search
  const SYNONYMS: Record<string, string[]> = {
    "developer": ["programmer", "coder", "engineer", "dev", "software"],
    "designer": ["artist", "creative", "ui", "ux", "graphic"],
    "writer": ["author", "content", "copywriter", "blogger", "journalist"],
    "marketing": ["seo", "advertising", "promotion", "social", "digital"],
    "website": ["web", "site", "webapp", "portal", "page"],
    "mobile": ["app", "ios", "android", "application", "smartphone"],
    "data": ["analytics", "statistics", "analysis", "database", "science"],
    "backend": ["server", "api", "database", "infrastructure"],
    "frontend": ["ui", "interface", "client", "responsive"],
    "fullstack": ["full-stack", "full stack", "end-to-end"],
  };

  // Job routes with enhanced fuzzy search
  app.get("/api/jobs", requireAuth, async (req, res) => {
    try {
      const { search, category, minBudget, maxBudget } = req.query;
      
      // Get jobs visible on the browse page (open jobs + claimed/in-progress for transparency)
      const allJobs = await storage.getJobs({});
      let jobs = allJobs.filter(j => 
        j.status === JobStatus.PENDING_ACCEPTANCE ||
        j.status === JobStatus.CLAIMED ||
        j.status === JobStatus.IN_PROGRESS ||
        j.status === "active"
      );
      
      // Apply category filter
      if (category && category !== "All Categories") {
        jobs = jobs.filter(j => j.category === category);
      }
      
      // Apply fuzzy search with synonym expansion
      if (search && typeof search === "string" && search.trim()) {
        const searchTerm = search.toLowerCase().trim();
        
        // Expand search with synonyms
        const expandedTerms = [searchTerm];
        Object.entries(SYNONYMS).forEach(([key, synonyms]) => {
          // Add synonyms if search term fuzzy matches the key or any synonym
          if (fuzzyMatch(searchTerm, key, 0.75) || 
              synonyms.some(s => fuzzyMatch(searchTerm, s, 0.75))) {
            expandedTerms.push(key, ...synonyms);
          }
        });
        
        jobs = jobs.filter(job => {
          const searchableText = `${job.title} ${job.description} ${job.category}`.toLowerCase();
          const words = searchableText.split(/\s+/);
          
          // Check if any expanded term fuzzy matches any word in the searchable text
          return expandedTerms.some(term => 
            words.some(word => fuzzyMatch(term, word, 0.7)) ||
            searchableText.includes(term)
          );
        });
      }
      
      // Apply budget range filter
      if (minBudget || maxBudget) {
        jobs = jobs.filter(job => {
          const budget = parseFloat(job.budget);
          if (isNaN(budget)) return false;
          
          const min = minBudget ? parseFloat(minBudget as string) : 0;
          const max = maxBudget ? parseFloat(maxBudget as string) : Infinity;
          
          return budget >= min && budget <= max;
        });
      }
      
      jobs.sort((a, b) => {
        const aPremium = parseFloat(a.premiumAmount || "0");
        const bPremium = parseFloat(b.premiumAmount || "0");
        return bPremium - aPremium;
      });
      
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/jobs/recent", requireAuth, async (req, res) => {
    try {
      const allJobs = await storage.getJobs({});
      const jobs = allJobs.filter(j => 
        j.status === JobStatus.PENDING_ACCEPTANCE || j.status === "active"
      );
      jobs.sort((a, b) => {
        const aPremium = parseFloat(a.premiumAmount || "0");
        const bPremium = parseFloat(b.premiumAmount || "0");
        return bPremium - aPremium;
      });
      res.json(jobs.slice(0, 10));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Oldest premium jobs posted by customers, for the freelancer dashboard.
  // Jobs can only be created by customers (POST /api/jobs enforces the role),
  // so every job here is customer-posted by construction.
  app.get("/api/jobs/available-premium", requireAuth, async (req, res) => {
    try {
      const allJobs = await storage.getJobs({});
      const jobs = allJobs
        .filter(j =>
          (j.status === JobStatus.PENDING_ACCEPTANCE || j.status === "active") &&
          (j.isPremium || parseFloat(j.premiumAmount || "0") > 0)
        )
        .sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/my-jobs", requireRole("customer"), async (req, res) => {
    try {
      const jobs = await storage.getJobs({ customerId: req.session.userId! });
      // Filter out archived jobs unless specifically requested
      const includeArchived = req.query.includeArchived === "true";
      const filteredJobs = includeArchived ? jobs : jobs.filter(j => !j.customerArchived);
      
      // Add hasRating info for completed jobs
      const enrichedJobs = await Promise.all(filteredJobs.map(async (job) => {
        if (job.status === "completed" && job.freelancerId) {
          const rating = await storage.getRating(job.id);
          return { ...job, hasRating: !!rating };
        }
        return { ...job, hasRating: false };
      }));
      
      res.json(enrichedJobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Archive a completed job (customer clears it from their list)
  app.post("/api/jobs/:id/archive", requireRole("customer"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can archive this job" });
      }

      if (job.status !== "completed" && job.status !== "cancelled") {
        return res.status(400).json({ error: "Only completed or cancelled jobs can be archived" });
      }

      // For completed jobs with a freelancer, require rating before archiving
      if (job.status === "completed" && job.freelancerId) {
        const rating = await storage.getRating(job.id);
        if (!rating) {
          return res.status(400).json({ error: "Please rate the freelancer before clearing this job" });
        }
      }

      const updatedJob = await storage.updateJob(job.id, { customerArchived: true });
      res.json(updatedJob);
    } catch (error) {
      console.error("Error archiving job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get freelancer's current/assigned jobs (claimed, in_progress, completed)
  app.get("/api/freelancer/jobs", requireRole("freelancer"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      // Get all jobs where this user is the freelancer or a collaborator
      const allJobs = await storage.getJobs({});
      
      // Also check jobFreelancers table for multi-freelancer assignments
      const freelancerAssignments = await storage.getJobFreelancersByFreelancer(userId);
      const assignedJobIds = new Set(freelancerAssignments.map(jf => jf.jobId));
      
      const freelancerJobs = allJobs.filter(job => 
        job.freelancerId === userId || 
        (job.collaborators && job.collaborators.includes(userId)) ||
        assignedJobIds.has(job.id)
      );
      
      res.json(freelancerJobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });


  app.get("/api/jobs/:id", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Enrich job data with customer info
      const customer = await storage.getUser(job.customerId);
      
      // Enrich with collaborator info - include jobFreelancers table for multi-freelancer jobs
      const collaboratorIds = job.collaborators || [];
      const jobFreelancerRecords = await storage.getJobFreelancers(job.id);
      const jobFreelancerIds = jobFreelancerRecords.map(jf => jf.freelancerId);
      
      // Combine all member IDs (primary freelancer + collaborators + jobFreelancers), removing duplicates
      const allMemberIdSet = new Set([
        ...(job.freelancerId ? [job.freelancerId] : []),
        ...collaboratorIds,
        ...jobFreelancerIds
      ]);
      const allMemberIds = Array.from(allMemberIdSet);
      
      const collaboratorData = await Promise.all(
        allMemberIds.map(async (id) => {
          const user = await storage.getUser(id);
          return user ? {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            specialization: user.specialization,
          } : null;
        })
      );

      // Calculate profit splits
      const profitSplits = allMemberIds.length > 0 ? await calculateProfitSplits(job, allMemberIds) : [];

      // Effective project leader (first freelancer unless a vote changed it)
      const projectLeaderId = job.projectLeaderId || job.freelancerId;
      const projectLeader = projectLeaderId ? await storage.getUser(projectLeaderId) : null;
      const activeLeadershipVote = await getActiveLeadershipVoteEnriched(job, req.session.userId);

      const enrichedJob = {
        ...job,
        customerUsername: customer?.username,
        customerDiscordId: customer?.discordId,
        customerAvatar: customer?.avatar || null,
        collaboratorData: collaboratorData.filter(Boolean),
        profitSplits,
        teamMemberIds: allMemberIds,
        projectLeaderUsername: projectLeader?.username || null,
        activeLeadershipVote,
      };

      res.json(enrichedJob);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  async function calculateProfitSplits(job: any, memberIds: string[]) {
    const budget = parseFloat(job.budget);
    const totalMembers = memberIds.length;
    const basePercentage = 100 / totalMembers;
    const baseShareAmount = budget / totalMembers;

    const splits = await Promise.all(
      memberIds.map(async (userId) => {
        const user = await storage.getUser(userId);
        const level = user?.level || 1;
        const levelPayout = getLevelPayout(level);
        const actualAmount = baseShareAmount * levelPayout;

        return {
          userId,
          level,
          percentage: parseFloat(basePercentage.toFixed(2)),
          baseAmount: baseShareAmount.toFixed(2),
          levelPayout: (levelPayout * 100).toFixed(0) + "%",
          amount: actualAmount.toFixed(2),
        };
      })
    );

    return splits;
  }

  app.post("/api/jobs", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.role !== "customer") {
        return res.status(403).json({ error: "Only customers can post jobs" });
      }

      // Block job creation if customer has a pending role upgrade request
      const pendingUpgrades = await storage.getRoleUpgradeRequests({
        userId: user.id,
        status: RoleUpgradeStatus.PENDING,
      });
      if (pendingUpgrades.length > 0) {
        return res.status(400).json({
          error: "You cannot post new jobs while you have a pending role upgrade request. Please wait for it to be processed or withdraw it first."
        });
      }

      const validated = insertJobSchema.parse(req.body);
      
      // Content filtering for job posts
      const contentToCheck = `${validated.title} ${validated.description} ${validated.requirements || ""}`;
      const filterResult = filterContent(contentToCheck);
      
      if (!filterResult.isClean && filterResult.severity === "high") {
        return res.status(400).json({ 
          error: "Job posting contains inappropriate content",
          flags: filterResult.flags
        });
      }
      
      if (isSpamLike(contentToCheck)) {
        return res.status(400).json({ error: "Job posting appears to contain spam content" });
      }
      
      // Sanitize text fields
      validated.title = sanitizeText(validated.title);
      validated.description = sanitizeText(validated.description);
      if (validated.requirements) {
        validated.requirements = sanitizeText(validated.requirements);
      }

      const existingJobs = await storage.getJobs({ customerId: req.session.userId! });
      const hasPendingReview = existingJobs.find(
        j => j.status === JobStatus.PENDING_APPROVAL || j.status === "pending"
      );
      if (hasPendingReview) {
        return res.status(400).json({
          error: `You already have a job pending review ("${hasPendingReview.title}"). Please wait for it to be reviewed before submitting another.`
        });
      }

      const wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        return res.status(400).json({ error: "Wallet not found" });
      }

      const budget = parseFloat(validated.budget);
      if (Number.isNaN(budget) || budget < 5) {
        return res.status(400).json({ error: "Budget must be at least $5" });
      }
      const premiumFee = parseFloat(validated.premiumAmount || "0");
      if (validated.isPremium && premiumFee < 100) {
        return res.status(400).json({ error: "Premium amount must be at least $100" });
      }
      const totalCost = budget + (validated.isPremium ? premiumFee : 0);
      const walletBalance = parseFloat(wallet.usdtBalance || "0");

      if (totalCost > walletBalance) {
        return res.status(400).json({ 
          error: `Insufficient funds. Need $${totalCost.toFixed(2)} (budget${premiumFee > 0 ? ` + $${premiumFee.toFixed(2)} premium` : ""}). Balance: $${walletBalance.toFixed(2)}.`
        });
      }

      // Charge wallet immediately when creating job for review
      await storage.updateWallet(req.session.userId!, {
        usdtBalance: (walletBalance - totalCost).toFixed(8),
      });

      await storage.createTransaction({
        walletId: wallet.id,
        type: "escrow_lock",
        currency: "USDT",
        amount: totalCost.toFixed(8),
        usdAmount: totalCost.toFixed(2),
        status: "completed",
        transactionHash: `escrow-lock-newjob-${Date.now()}`,
      });

      const job = await storage.createJob({
        ...validated,
        premiumAmount: validated.isPremium ? (premiumFee || 0).toString() : "0",
        customerId: req.session.userId!,
        status: "pending",
        submittedForReviewAt: new Date(),
      });

      // Create escrow record
      await storage.createEscrow({
        jobId: job.id,
        customerId: req.session.userId!,
        totalAmount: totalCost.toFixed(2),
        status: EscrowStatus.HELD,
      });

      res.json(job);
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Invalid job data" });
    }
  });

  app.put("/api/jobs/:id", requireRole("customer"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only the job owner can edit
      if (job.customerId !== req.session.userId!) {
        return res.status(403).json({ error: "You can only edit your own jobs" });
      }

      // Only allow editing if job is pending, changes_requested, or rejected
      if (!["pending", "changes_requested", "rejected"].includes(job.status)) {
        return res.status(400).json({ error: "Cannot edit jobs that are active or in progress" });
      }

      const validated = insertJobSchema.parse(req.body);
      
      // Check wallet balance covers budget + premium fee
      const wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        return res.status(400).json({ error: "Wallet not found" });
      }

      const budget = parseFloat(validated.budget);
      if (Number.isNaN(budget) || budget < 5) {
        return res.status(400).json({ error: "Budget must be at least $5" });
      }
      const premiumFee = parseFloat(validated.premiumAmount || "0");
      if (validated.isPremium && premiumFee < 100) {
        return res.status(400).json({ error: "Premium amount must be at least $100" });
      }
      const totalCost = budget + (validated.isPremium ? premiumFee : 0);
      const availableBalance = parseFloat(wallet.usdtBalance || "0") - parseFloat(wallet.pendingUsdtBalance || "0");

      if (totalCost > availableBalance) {
        return res.status(400).json({ 
          error: `Insufficient funds. Need $${totalCost.toFixed(2)} (budget${premiumFee > 0 ? ` + $${premiumFee.toFixed(2)} premium` : ""}). Available: $${availableBalance.toFixed(2)}.`
        });
      }

      const updatedJob = await storage.updateJob(req.params.id, {
        ...validated,
        premiumAmount: validated.isPremium ? (premiumFee || 0).toString() : "0",
        status: "pending",
        moderatorFeedback: null,
      });

      res.json(updatedJob);
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Invalid job data" });
    }
  });

  // ── Deadline lifecycle: extend / put back on market / end / freelancer response ──
  function getAssignedFreelancerIds(job: any): string[] {
    const set = new Set<string>();
    if (job.freelancerId) set.add(job.freelancerId);
    if (job.collaborators) for (const id of job.collaborators) set.add(id);
    return Array.from(set);
  }

  async function notifyModerators(title: string, message: string, jobId: string) {
    const users = await storage.getUsers();
    const modRoles = ["staff", "moderator", "head_of_moderation", "founder"];
    for (const mod of users.filter(u => modRoles.includes(u.role))) {
      await storage.createNotification({
        userId: mod.id,
        type: "dispute_escalated",
        title,
        message,
        relatedId: jobId,
        sourceType: "job",
        sourceId: jobId,
      });
    }
  }

  // Customer extends the deadline (status returns to a working state; reminders restart).
  app.post("/api/jobs/:id/deadline-extend", requireRole("customer"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId!) return res.status(403).json({ error: "Only the job owner can extend the deadline" });
      if (job.status !== JobStatus.DEADLINE_REACHED) return res.status(400).json({ error: "Deadline extension is only available after the deadline has been reached" });

      const deadline = new Date(req.body.deadline);
      if (Number.isNaN(deadline.getTime())) return res.status(400).json({ error: "Please provide a valid deadline" });
      if (deadline.getTime() <= Date.now()) return res.status(400).json({ error: "Deadline must be in the future" });

      // If a freelancer never accepted the job, extending the deadline should put it
      // back on the market (ACTIVE) so freelancers can apply. Only restore the working
      // "in progress" state if someone was actually assigned to the job.
      const assigned = await storage.getJobFreelancers(job.id);
      const hasFreelancer = !!(job.freelancerId || (job.collaborators && job.collaborators.length) || assigned.length > 0);

      const updated = await storage.updateJob(job.id, {
        deadline,
        status: hasFreelancer ? JobStatus.IN_PROGRESS : JobStatus.ACTIVE,
        isLocked: false,
        lastDeadlineReminderAt: null,
        deadlineArrivalNotified: false,
      });

      for (const freelancerId of getAssignedFreelancerIds(job)) {
        await storage.createNotification({
          userId: freelancerId,
          type: "job_updated",
          title: "Deadline extended",
          message: `The deadline for "${job.title}" has been extended. Stay on track and share progress updates with the client.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Failed to extend deadline" });
    }
  });

  // Customer puts the job back on the market, editing any details + setting a new deadline.
  app.post("/api/jobs/:id/remarket", requireRole("customer"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId!) return res.status(403).json({ error: "Only the job owner can relist the job" });
      if (job.status !== JobStatus.DEADLINE_REACHED && job.status !== JobStatus.IN_PROGRESS) {
        return res.status(400).json({ error: "This job cannot be put back on the market in its current state" });
      }

      const body = req.body || {};
      const deadline = new Date(body.deadline);
      if (Number.isNaN(deadline.getTime())) return res.status(400).json({ error: "Please provide a deadline" });
      if (deadline.getTime() <= Date.now()) return res.status(400).json({ error: "Deadline must be in the future" });
      if (!body.budget || Number.isNaN(parseFloat(body.budget)) || parseFloat(body.budget) < 5) {
        return res.status(400).json({ error: "Budget must be at least $5" });
      }

      // Handle budget change against wallet + escrow.
      const oldBudget = parseFloat(job.budget);
      const newBudget = parseFloat(body.budget);
      const oldPremium = parseFloat(job.premiumAmount || "0");
      const newPremium = body.isPremium ? (parseFloat(body.premiumAmount || "0") || 0) : 0;
      const wallet = await storage.getWallet(job.customerId);
      if (wallet) {
        const walletBalance = parseFloat(wallet.usdtBalance || "0");
        const diff = (newBudget + newPremium) - (oldBudget + oldPremium);
        if (diff > 0 && diff > walletBalance) {
          return res.status(400).json({ error: `Insufficient funds. Need an additional $${diff.toFixed(2)}.` });
        }
        if (diff !== 0) {
          await storage.updateWallet(job.customerId, {
            usdtBalance: (walletBalance - diff).toFixed(8),
          });
        }
      }
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow) {
        await storage.updateEscrow(escrow.id, { totalAmount: (newBudget + newPremium).toFixed(2) });
      }

      // Release the current freelancer(s) and relist.
      const workers = await storage.getJobFreelancers(job.id);
      for (const w of workers) await storage.deleteJobFreelancer(w.id);

      const updated = await storage.updateJob(job.id, {
        title: body.title?.trim() ?? job.title,
        description: body.description?.trim() ?? job.description,
        category: body.category ?? job.category,
        budget: newBudget.toFixed(2),
        requirements: body.requirements?.trim() ?? job.requirements,
        deadline,
        premiumAmount: newPremium > 0 ? newPremium.toFixed(2) : "0",
        isPremium: newPremium > 0,
        status: JobStatus.ACTIVE,
        freelancerId: null,
        projectLeaderId: null,
        collaborators: [],
        isLocked: false,
        lastDeadlineReminderAt: null,
        deadlineArrivalNotified: false,
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Failed to relist job" });
    }
  });

  // Customer ends the job: refund the budget, then ask the freelancer whether they completed the work.
  app.post("/api/jobs/:id/end", requireRole("customer"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId!) return res.status(403).json({ error: "Only the job owner can end the job" });
      if (job.status !== JobStatus.DEADLINE_REACHED) return res.status(400).json({ error: "You can only end a job after its deadline has been reached" });

      // Refund the customer's full locked amount (budget + premium), never just the budget.
      const escrow = await storage.getEscrowByJob(job.id);
      const refundAmount = escrow && parseFloat(escrow.totalAmount)
        ? parseFloat(escrow.totalAmount)
        : (parseFloat(job.budget) + (parseFloat(job.premiumAmount || "0") || 0));
      if (escrow) await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      await storage.adjustPendingBalance(job.customerId, -refundAmount);
      const customerWallet = await storage.getWallet(job.customerId);
      if (customerWallet) {
        const customerBalance = parseFloat(customerWallet.usdtBalance || "0");
        await storage.updateWallet(job.customerId, { usdtBalance: (customerBalance + refundAmount).toFixed(8) });
        await storage.createTransaction({
          walletId: customerWallet.id,
          type: "refund",
          currency: "USDT",
          amount: refundAmount.toFixed(8),
          usdAmount: refundAmount.toFixed(2),
          status: "completed",
          transactionHash: `deadline-end-refund-${job.id}-${Date.now()}`,
        });
      }

      await storage.updateJob(job.id, { status: JobStatus.ENDED, isLocked: true });

      // Ask the freelancer(s) whether they completed the work before the deadline.
      for (const freelancerId of getAssignedFreelancerIds(job)) {
        await storage.createNotification({
          userId: freelancerId,
          type: "job_updated",
          title: "The job has been ended",
          message: `The deadline for "${job.title}" has passed and the job was ended. Please confirm whether you completed the work before the deadline.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
          redirectUrl: `/jobs/${job.id}`,
        });
      }

      res.json({ ok: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Failed to end job" });
    }
  });

  // Freelancer answers the "did you complete the work before the deadline?" prompt.
  app.post("/api/jobs/:id/end-response", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.status !== JobStatus.ENDED) return res.status(400).json({ error: "This job has no pending completion confirmation" });

      const assignedIds = new Set([...getAssignedFreelancerIds(job), ...(await storage.getJobFreelancers(job.id)).map((w: any) => w.freelancerId)]);
      if (!assignedIds.has(req.session.userId!)) return res.status(403).json({ error: "Only assigned freelancers can respond" });

      const completed = req.body.completed === true;

      if (!completed) {
        // Did not finish before the deadline: delete the job (customer already refunded).
        await storage.deleteJob(job.id);
        await storage.createNotification({
          userId: job.customerId,
          type: "job_cancelled",
          title: "Job closed",
          message: `The freelancer confirmed they did not complete "${job.title}" before the deadline, so the job was closed and you were refunded.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
        return res.json({ ok: true, outcome: "deleted" });
      }

      // Claims completion: reopen the budget into escrow and open a dispute for a moderator to decide.
      const budget = parseFloat(job.budget);
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow) await storage.updateEscrow(escrow.id, { status: EscrowStatus.HELD });
      await storage.adjustPendingBalance(job.customerId, budget);
      const customerWallet = await storage.getWallet(job.customerId);
      if (customerWallet) {
        const customerBalance = parseFloat(customerWallet.usdtBalance || "0");
        await storage.updateWallet(job.customerId, { usdtBalance: (customerBalance - budget).toFixed(8) });
        await storage.createTransaction({
          walletId: customerWallet.id,
          type: "escrow_lock",
          currency: "USDT",
          amount: budget.toFixed(8),
          usdAmount: budget.toFixed(2),
          status: "completed",
          transactionHash: `deadline-dispute-relock-${job.id}-${Date.now()}`,
        });
      }

      await storage.updateJob(job.id, { status: JobStatus.DISPUTE, isLocked: true });
      const dispute = await storage.createDispute({
        jobId: job.id,
        openedByUserId: job.customerId,
        reason: "Deadline missed but freelancer claims the work was completed before the deadline",
      });

      await notifyModerators(
        "New deadline dispute",
        `A dispute was opened on "${job.title}": the freelancer claims the work was completed before the deadline.`,
        job.id
      );
      await storage.createNotification({
        userId: job.customerId,
        type: "dispute_opened",
        title: "Dispute opened",
        message: `A dispute has been opened for "${job.title}". A moderator will review both sides.`,
        relatedId: dispute.id,
        sourceType: "dispute",
        sourceId: dispute.id,
      });

      res.json({ ok: true, outcome: "dispute", disputeId: dispute.id });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Failed to record response" });
    }
  });

  // Customer deletes a job that no freelancer ever accepted (e.g. its deadline
  // passed while it was still on the market). Refunds the locked budget and removes
  // the listing. Only allowed while the job has no freelancer assigned.
  app.delete("/api/jobs/:id", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId!) {
        return res.status(403).json({ error: "Only the job owner can delete this job" });
      }
      if (job.status !== JobStatus.ACTIVE && job.status !== JobStatus.DEADLINE_REACHED) {
        return res.status(400).json({ error: "Only a job that is still on the market can be deleted" });
      }

      const assigned = await storage.getJobFreelancers(job.id);
      const hasFreelancer = !!(job.freelancerId || (job.collaborators && job.collaborators.length) || assigned.length > 0);
      if (hasFreelancer) {
        return res.status(400).json({ error: "This job has already been accepted by a freelancer and cannot be deleted" });
      }

      // Refund the customer's full locked amount (budget + premium), never just the budget.
      const escrow = await storage.getEscrowByJob(job.id);
      const refundAmount = escrow && parseFloat(escrow.totalAmount)
        ? parseFloat(escrow.totalAmount)
        : (parseFloat(job.budget) + (parseFloat(job.premiumAmount || "0") || 0));
      if (escrow) await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      await storage.adjustPendingBalance(job.customerId, -refundAmount);
      const customerWallet = await storage.getWallet(job.customerId);
      if (customerWallet) {
        const customerBalance = parseFloat(customerWallet.usdtBalance || "0");
        await storage.updateWallet(job.customerId, { usdtBalance: (customerBalance + refundAmount).toFixed(8) });
        await storage.createTransaction({
          walletId: customerWallet.id,
          type: "refund",
          currency: "USDT",
          amount: refundAmount.toFixed(8),
          usdAmount: refundAmount.toFixed(2),
          status: "completed",
          transactionHash: `job-delete-refund-${job.id}-${Date.now()}`,
        });
      }

      await storage.deleteJob(job.id);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Failed to delete job" });
    }
  });

  // Get job requests for a specific job (for customers to see applicants)
  app.get("/api/jobs/:id/requests", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only job owner, lead freelancer, or moderators can see requests
      const user = await storage.getUser(req.session.userId!);
      if (job.customerId !== req.session.userId! &&
          job.freelancerId !== req.session.userId! &&
          !["staff", "moderator", "head_of_moderation", "founder"].includes(user?.role || "")) {
        return res.status(403).json({ error: "Not authorized to view job requests" });
      }

      const requests = await storage.getJobRequestsByJob(req.params.id);
      
      // Enrich with freelancer data
      const enrichedRequests = await Promise.all(
        requests.map(async (request) => {
          const freelancer = await storage.getUser(request.freelancerId);
          return {
            ...request,
            freelancer: freelancer ? {
              id: freelancer.id,
              userId: freelancer.userId,
              username: freelancer.username,
              avatar: freelancer.avatar,
              level: freelancer.level,
              rating: freelancer.rating,
              completedJobs: freelancer.completedJobs,
              completionPercentage: freelancer.completionPercentage,
              portfolio: freelancer.portfolio,
            } : null,
          };
        })
      );

      res.json(enrichedRequests);
    } catch (error) {
      console.error("Error getting job requests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get freelancer's job requests (all statuses)
  app.get("/api/my-job-requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can view their job requests" });
      }

      const userId = req.session.userId!;
      // Every job a freelancer has ever been on represents an accepted
      // application. Lifetime finished jobs come from the user counter
      // (totalJobs), plus any jobs currently in progress/claimed/submitted
      // that are not yet counted there.
      const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted", "disputed"];
      const allJobs = await storage.getJobs({});
      const jobFreelancerRows = await storage.getJobFreelancersByFreelancer(userId);
      const assignedJobIds = new Set<string>();
      for (const job of allJobs) {
        if (
          job.freelancerId === userId ||
          job.collaborators?.includes(userId)
        ) {
          assignedJobIds.add(job.id);
        }
      }
      for (const jf of jobFreelancerRows) {
        assignedJobIds.add(jf.jobId);
      }

      const activeAssignedCount = Array.from(assignedJobIds).filter((id) => {
        const job = allJobs.find((j) => j.id === id);
        return !!job && activeStatuses.includes(job.status);
      }).length;

      // Lifetime totals: finished jobs (completed, cancelled, etc.) from the
      // user record + currently active assignments. This is the source of
      // truth for "accepted applications" - every job worked counts.
      const lifetimeJobs = user.totalJobs || 0;
      const acceptedCount = lifetimeJobs + activeAssignedCount;

      // Real application records (pending / rejected / withdrawn / cancelled)
      // that never turned into a job add to total applications but not accepted.
      const requests = await storage.getJobRequestsByFreelancer(userId);
      const pendingCount = requests.filter((r) => r.status === "pending").length;
      const otherRequestCount = requests.filter((r) => r.status !== "pending" && r.status !== "accepted").length;
      const totalCount = acceptedCount + pendingCount + otherRequestCount;

      // History list: real request records plus synthetic accepted entries for
      // jobs the freelancer is assigned to that have no request row.
      const requestedJobIds = new Set(requests.map((r) => r.jobId));
      const allEnriched = await Promise.all(
        requests.map(async (request) => {
          const job = await storage.getJob(request.jobId);
          return {
            ...request,
            job: job ? {
              id: job.id,
              title: job.title,
              budget: job.budget,
              category: job.category,
              status: job.status,
              customerId: job.customerId,
              deadline: job.deadline,
            } : null,
          };
        })
      );

      const synthetic: any[] = [];
      for (const jobId of Array.from(assignedJobIds)) {
        if (requestedJobIds.has(jobId)) continue;
        const job = await storage.getJob(jobId);
        if (!job) continue;
        synthetic.push({
          id: `assigned-${jobId}`,
          jobId: job.id,
          freelancerId: userId,
          status: "accepted",
          message: null,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          job: {
            id: job.id,
            title: job.title,
            budget: job.budget,
            category: job.category,
            status: job.status,
            customerId: job.customerId,
            deadline: job.deadline,
          },
        });
      }

      const applications = [...allEnriched, ...synthetic].sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );

      res.json({
        applications,
        stats: {
          totalApplications: totalCount,
          accepted: acceptedCount,
          pending: pendingCount,
        },
      });
    } catch (error) {
      console.error("Error getting my job requests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  app.post("/api/jobs/:id/claim", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "Your account could not be found. Please log in again." });
      }

      if (user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can apply for jobs. Please upgrade your account to become a freelancer." });
      }

      // Check if freelancer already has an active/claimed job (as primary, team member, collaborator, or via jobFreelancers)
      const allJobs = await storage.getJobs({});
      const userId = req.session.userId!;
      const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted"];
      
      // Check if user is assigned to any active job (as freelancerId, teamMembers, or collaborators)
      const assignedActiveJobs = allJobs.filter(j => {
        if (!activeStatuses.includes(j.status)) return false;
        // Check primary freelancer
        if (j.freelancerId === userId) return true;
        // Check team members array
        if (j.teamMembers?.includes(userId)) return true;
        // Check collaborators array (from invitation acceptance)
        if (j.collaborators?.includes(userId)) return true;
        return false;
      });

      if (assignedActiveJobs.length > 0) {
        return res.status(400).json({ error: "You are already assigned to an active job. Complete it before applying to new jobs." });
      }

      // Also check jobFreelancers table for multi-freelancer assignments (recommendation system)
      const jobFreelancerAssignments = await storage.getJobFreelancersByFreelancer(userId);
      for (const jf of jobFreelancerAssignments) {
        const assignedJob = await storage.getJob(jf.jobId);
        if (assignedJob && activeStatuses.includes(assignedJob.status)) {
          return res.status(400).json({ error: "You are already assigned to an active job. Complete it before applying to new jobs." });
        }
      }

      // Check pending request limit (max 5)
      const pendingRequests = await storage.getPendingJobRequestsByFreelancer(req.session.userId!);
      if (pendingRequests.length >= 5) {
        return res.status(400).json({ error: "You have reached the maximum of 5 pending job applications. Cancel one to apply to another." });
      }

      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "This job no longer exists. It may have been removed by the customer." });
      }

      // Check if freelancer is blacklisted by this customer
      const customer = await storage.getUser(job.customerId);
      if (customer?.blacklistedFreelancers?.includes(req.session.userId!)) {
        return res.status(403).json({ error: "You are not eligible to apply for this customer's jobs." });
      }
      
      if (job.status === "completed") {
        return res.status(400).json({ error: "This job has already been completed." });
      }
      
      if (job.status === "cancelled") {
        return res.status(400).json({ error: "This job has been cancelled by the customer." });
      }
      
      if (job.status === "in_progress" || job.status === "claimed") {
        return res.status(400).json({ error: "This job has already been assigned to another freelancer." });
      }
      
      if (job.status !== "active") {
        return res.status(400).json({ error: "This job is not currently available for applications." });
      }

      // Check if freelancer already applied to this job
      const existingRequest = await storage.getJobRequestByJobAndFreelancer(req.params.id, req.session.userId!);
      if (existingRequest && existingRequest.status === "pending") {
        return res.status(400).json({ error: "You have already applied to this job." });
      }

      // Check if job has expired
      if (job.deadline) {
        const deadline = new Date(job.deadline);
        if (deadline < new Date()) {
          return res.status(400).json({ error: "This job has expired. The deadline has passed." });
        }
      }

      // Create job request (not directly assigning to job)
      const jobRequest = await storage.createJobRequest({
        jobId: req.params.id,
        freelancerId: req.session.userId!,
        status: "pending",
        message: req.body.message || null,
      });

      // Create notification for customer (if they have team request notifications enabled)
      const customerPrefs = await storage.getUserPreferences(job.customerId);
      const teamRequestEnabled = customerPrefs?.teamRequestNotificationsEnabled ?? true;
      if (teamRequestEnabled) {
        await storage.createNotification({
          userId: job.customerId,
          type: "job_request",
          title: "New job application",
          message: `${user.username} has applied to work on your job: ${job.title}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json({ success: true, request: jobRequest });
    } catch (error) {
      console.error("Error applying for job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Cancel a job application
  app.post("/api/jobs/:id/cancel-request", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const jobRequest = await storage.getJobRequestByJobAndFreelancer(req.params.id, req.session.userId!);
      if (!jobRequest) {
        return res.status(404).json({ error: "No application found for this job" });
      }

      if (jobRequest.status !== "pending") {
        return res.status(400).json({ error: "Can only cancel pending applications" });
      }

      await storage.updateJobRequest(jobRequest.id, { status: "withdrawn" });

      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling job request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer approve a freelancer from the request queue
  app.post("/api/jobs/:id/approve-freelancer", requireAuth, async (req, res) => {
    try {
      const { freelancerId } = req.body;
      if (!freelancerId) {
        return res.status(400).json({ error: "Freelancer ID is required" });
      }

      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId!) {
        return res.status(403).json({ error: "Only the job owner can approve freelancers" });
      }

      if (job.status !== "active") {
        return res.status(400).json({ error: "This job is not available for assignment" });
      }

      // Find the pending request for this freelancer
      const jobRequest = await storage.getJobRequestByJobAndFreelancer(req.params.id, freelancerId);
      if (!jobRequest || jobRequest.status !== "pending") {
        return res.status(404).json({ error: "No pending application found from this freelancer" });
      }

      // Check if freelancer is still eligible (no active jobs)
      const freelancerActiveJobs = await storage.getJobs({ freelancerId, status: "in_progress" });
      const freelancerClaimedJobs = await storage.getJobs({ freelancerId, status: "claimed" });
      if (freelancerActiveJobs.length > 0 || freelancerClaimedJobs.length > 0) {
        // Mark the request as cancelled since freelancer is busy
        await storage.updateJobRequest(jobRequest.id, { status: "cancelled" });
        return res.status(400).json({ error: "This freelancer already has an active job and cannot accept new jobs" });
      }

      // Funds already deducted from customer wallet at job submission time
      // No need for additional balance check or pending balance adjustment

      // Update job - assign to freelancer and set status to claimed
      const updatedJob = await storage.updateJob(req.params.id, {
        status: "claimed",
        freelancerId: freelancerId,
      });

      // Mark this request as accepted
      await storage.updateJobRequest(jobRequest.id, { status: "accepted" });

      // Cancel all other pending requests for this job
      const allRequests = await storage.getJobRequestsByJob(req.params.id);
      for (const request of allRequests) {
        if (request.id !== jobRequest.id && request.status === "pending") {
          await storage.updateJobRequest(request.id, { status: "rejected" });
          // Notify rejected freelancers
          await storage.createNotification({
            userId: request.freelancerId,
            type: "job_rejected",
            title: "Application not selected",
            message: `Another freelancer was selected for "${job.title}".`,
            relatedId: job.id,
            sourceType: "job",
            sourceId: job.id,
          });
        }
      }

      // Cancel all other pending requests from this freelancer (they now have a job)
      await storage.cancelPendingJobRequestsByFreelancer(freelancerId, req.params.id);

      // Notify the accepted freelancer
      await storage.createNotification({
        userId: freelancerId,
        type: "job_approved",
        title: "Application accepted!",
        message: `Your application for "${job.title}" has been accepted. You can now start working!`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      console.error("Error approving freelancer:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer reject a freelancer from the request queue
  app.post("/api/jobs/:id/reject-freelancer", requireAuth, async (req, res) => {
    try {
      const { freelancerId } = req.body;
      if (!freelancerId) {
        return res.status(400).json({ error: "Freelancer ID is required" });
      }

      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId!) {
        return res.status(403).json({ error: "Only the job owner can reject freelancers" });
      }

      // Find the pending request for this freelancer
      const jobRequest = await storage.getJobRequestByJobAndFreelancer(req.params.id, freelancerId);
      if (!jobRequest || jobRequest.status !== "pending") {
        return res.status(404).json({ error: "No pending application found from this freelancer" });
      }

      // Mark request as rejected
      await storage.updateJobRequest(jobRequest.id, { status: "rejected" });

      // Notify freelancer
      await storage.createNotification({
        userId: freelancerId,
        type: "job_rejected",
        title: "Application declined",
        message: `Your application for "${job.title}" was not selected.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error rejecting freelancer:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Freelancer requests to join the team of a job that already has one
  // (claimed / in_progress). The request lands in the same job-requests queue
  // and is approved/declined by the customer or the lead freelancer via the
  // join-requests endpoints below. Approving adds the freelancer to the job's
  // collaborators (equal profit share), matching invitation acceptance.
  app.post("/api/jobs/:id/join-request", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "Your account could not be found. Please log in again." });
      }

      if (user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can request to join a team." });
      }

      const userId = req.session.userId!;
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "This job no longer exists. It may have been removed by the customer." });
      }

      // Only jobs that already have a working team accept join requests.
      if (job.status !== "claimed" && job.status !== "in_progress") {
        return res.status(400).json({ error: "Join requests are only available for jobs that already have a team." });
      }

      // Not for people already on the team.
      const onTeam =
        job.freelancerId === userId ||
        job.collaborators?.includes(userId);
      if (onTeam) {
        return res.status(400).json({ error: "You are already part of this job's team." });
      }
      const existingAssignments = await storage.getJobFreelancersByFreelancer(userId);
      if (existingAssignments.some(jf => jf.jobId === job.id)) {
        return res.status(400).json({ error: "You are already part of this job's team." });
      }

      // Blacklist check (same policy as regular applications).
      const customer = await storage.getUser(job.customerId);
      if (customer?.blacklistedFreelancers?.includes(userId)) {
        return res.status(403).json({ error: "You are not eligible to work with this customer." });
      }

      // A freelancer busy on another active job cannot join a team.
      const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted"];
      const assignedActiveJobs = (await storage.getJobs({})).filter(j => {
        if (!activeStatuses.includes(j.status)) return false;
        return j.freelancerId === userId || j.collaborators?.includes(userId);
      });
      if (assignedActiveJobs.length > 0) {
        return res.status(400).json({ error: "You are already assigned to an active job. Complete it before requesting to join a team." });
      }
      for (const jf of existingAssignments) {
        const assignedJob = await storage.getJob(jf.jobId);
        if (assignedJob && activeStatuses.includes(assignedJob.status)) {
          return res.status(400).json({ error: "You are already assigned to an active job. Complete it before requesting to join a team." });
        }
      }

      // One pending request per freelancer per job (shared queue with applications).
      const existingRequest = await storage.getJobRequestByJobAndFreelancer(req.params.id, userId);
      if (existingRequest && existingRequest.status === "pending") {
        return res.status(400).json({ error: "You have already requested to join this job's team." });
      }

      const joinRequest = await storage.createJobRequest({
        jobId: req.params.id,
        freelancerId: userId,
        status: "pending",
        message: req.body.message || null,
      });

      // Notify the customer and the lead freelancer (each respects their own
      // Team Request Notifications preference).
      const joinRecipients = [job.customerId, job.freelancerId].filter(
        (id): id is string => !!id && id !== userId
      );
      for (const recipientId of joinRecipients) {
        const prefs = await storage.getUserPreferences(recipientId);
        if (prefs?.teamRequestNotificationsEnabled === false) continue;
        await storage.createNotification({
          userId: recipientId,
          type: "job_request",
          title: "New team join request",
          message: `${user.username} has requested to join the team for: ${job.title}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json({ success: true, request: joinRequest });
    } catch (error) {
      console.error("Error creating join request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Approve a join request — customer or lead freelancer. Adds the freelancer
  // to the job's collaborators (equal profit share), matching invitation
  // acceptance behavior.
  app.post("/api/jobs/:id/join-requests/:requestId/approve", requireAuth, async (req, res) => {
    try {
      const approverId = req.session.userId!;
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isCustomer = job.customerId === approverId;
      const isLead = job.freelancerId === approverId;
      if (!isCustomer && !isLead) {
        return res.status(403).json({ error: "Only the job owner or the lead freelancer can approve join requests" });
      }

      if (job.status !== "claimed" && job.status !== "in_progress") {
        return res.status(400).json({ error: "This job's team is no longer accepting members" });
      }

      const joinRequest = await storage.getJobRequest(req.params.requestId);
      if (!joinRequest || joinRequest.jobId !== job.id) {
        return res.status(404).json({ error: "Join request not found" });
      }
      if (joinRequest.status !== "pending") {
        return res.status(400).json({ error: "This request has already been handled" });
      }

      const freelancerId = joinRequest.freelancerId;
      const freelancer = await storage.getUser(freelancerId);

      // The freelancer must still be free to join.
      const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted"];
      const assignedActiveJobs = (await storage.getJobs({})).filter(j => {
        if (!activeStatuses.includes(j.status)) return false;
        return j.freelancerId === freelancerId || j.collaborators?.includes(freelancerId);
      });
      if (assignedActiveJobs.length > 0) {
        await storage.updateJobRequest(joinRequest.id, { status: "cancelled" });
        return res.status(400).json({ error: "This freelancer already has an active job and cannot join the team" });
      }
      const freelancerAssignments = await storage.getJobFreelancersByFreelancer(freelancerId);
      for (const jf of freelancerAssignments) {
        const assignedJob = await storage.getJob(jf.jobId);
        if (assignedJob && activeStatuses.includes(assignedJob.status)) {
          await storage.updateJobRequest(joinRequest.id, { status: "cancelled" });
          return res.status(400).json({ error: "This freelancer already has an active job and cannot join the team" });
        }
      }

      // Add to collaborators (idempotent).
      const collaborators = job.collaborators ? [...job.collaborators] : [];
      if (!collaborators.includes(freelancerId)) {
        collaborators.push(freelancerId);
        await storage.updateJob(job.id, { collaborators });
      }

      await storage.updateJobRequest(joinRequest.id, { status: "accepted" });

      // Notify the new team member.
      await storage.createNotification({
        userId: freelancerId,
        type: "job_approved",
        title: "Join request approved!",
        message: `Your request to join the team for "${job.title}" has been approved. You are now part of the team!`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error approving join request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Decline a join request — customer or lead freelancer.
  app.post("/api/jobs/:id/join-requests/:requestId/decline", requireAuth, async (req, res) => {
    try {
      const approverId = req.session.userId!;
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isCustomer = job.customerId === approverId;
      const isLead = job.freelancerId === approverId;
      if (!isCustomer && !isLead) {
        return res.status(403).json({ error: "Only the job owner or the lead freelancer can decline join requests" });
      }

      const joinRequest = await storage.getJobRequest(req.params.requestId);
      if (!joinRequest || joinRequest.jobId !== job.id) {
        return res.status(404).json({ error: "Join request not found" });
      }
      if (joinRequest.status !== "pending") {
        return res.status(400).json({ error: "This request has already been handled" });
      }

      await storage.updateJobRequest(joinRequest.id, { status: "rejected" });

      // Notify the requester.
      await storage.createNotification({
        userId: joinRequest.freelancerId,
        type: "job_rejected",
        title: "Join request declined",
        message: `Your request to join the team for "${job.title}" was declined.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error declining join request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Job completion route
  app.post("/api/jobs/:id/complete", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only customer or admin can mark job as complete
      const user = await storage.getUser(req.session.userId!);
      if (job.customerId !== req.session.userId! && user?.role !== "staff" && user?.role !== "moderator") {
        return res.status(403).json({ error: "Only the customer or admin can complete this job" });
      }

      if (job.status !== "claimed" && job.status !== "in_progress") {
        return res.status(400).json({ error: "Job must be claimed or in progress to complete" });
      }

      if (!job.freelancerId) {
        return res.status(400).json({ error: "No freelancer assigned to this job" });
      }

      // Funds already deducted from customer wallet at submission time
      // Just mark escrow as released and pay the freelancer
      const jobBudget = parseFloat(job.budget);
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.RELEASED });
      }

      // Transfer level-based portion of budget to freelancer (premium stays with Linxova)
      const freelancer2 = await storage.getUser(job.freelancerId);
      const level = freelancer2?.level || 1;
      const levelPayout = getLevelPayout(level);
      const payoutAmount = jobBudget * levelPayout;

      const freelancerWallet = await storage.getWallet(job.freelancerId);
      if (freelancerWallet) {
        const freelancerUSDT = parseFloat(freelancerWallet.usdtBalance || "0");
        await storage.updateWallet(job.freelancerId, {
          usdtBalance: (freelancerUSDT + payoutAmount).toFixed(8),
        });

        await storage.createTransaction({
          walletId: freelancerWallet.id,
          type: "deposit",
          currency: "USDT",
          amount: payoutAmount.toFixed(8),
          usdAmount: payoutAmount.toFixed(2),
          status: "completed",
          transactionHash: `job-payment-${job.id}`,
        });
      }

      // Mark job as completed
      const updatedJob = await storage.updateJob(req.params.id, { status: "completed" });

      // Update freelancer stats (completed jobs, completion %, level)
      const freelancer = await storage.getUser(job.freelancerId);
      if (freelancer) {
        // Counter-based completion rate: a completed job adds to both the
        // completedJobs numerator and the totalJobs denominator.
        const completedJobs = (freelancer.completedJobs || 0) + 1;
        const totalJobs = (freelancer.totalJobs || 0) + 1;
        const completionPercentage = totalJobs > 0
          ? ((completedJobs / totalJobs) * 100).toFixed(2)
          : "0.00";

        // Level is based on lifetime earnings, not completed jobs.
        const totalEarned = parseFloat(freelancer.totalEarned || "0") + payoutAmount;
        const newLevel = getLevelFromEarnings(totalEarned);

        // Update user with new stats
        await storage.updateUser(job.freelancerId, {
          completedJobs,
          totalJobs,
          completionPercentage,
          totalEarned: totalEarned.toFixed(2),
          level: newLevel,
        });
      }

      // Notify freelancer
      await storage.createNotification({
        userId: job.freelancerId,
        type: "job_completed",
        title: "Job completed!",
        message: `The job "${job.title}" has been completed and payment of $${jobBudget} USDT has been transferred to your wallet.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      console.error("Error completing job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================================
  // NEW JOB LIFECYCLE ROUTES (From Spec)
  // ============================================================

  // Submit job for approval (Customer submits DRAFT -> PENDING_APPROVAL)
  app.post("/api/jobs/:id/submit-for-approval", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can submit for approval" });
      }

      // Only draft, changes_requested, or rejected jobs can be submitted
      if (![JobStatus.DRAFT, "changes_requested", "rejected"].includes(job.status)) {
        return res.status(400).json({ error: "Only draft jobs can be submitted for approval" });
      }

      // Prevent submitting more than one job for review at a time (including this job itself)
      const customerJobs = await storage.getJobs({ customerId: job.customerId });
      const pendingReviewJob = customerJobs.find(
        j => (j.status === JobStatus.PENDING_APPROVAL || j.status === "pending")
      );
      if (pendingReviewJob) {
        return res.status(400).json({ 
          error: `You already have a job pending review ("${pendingReviewJob.title}"). Please wait for it to be reviewed before submitting another.`
        });
      }


      // Validate wallet balance covers budget + premium fee
      const wallet = await storage.getWallet(job.customerId);
      if (!wallet) {
        return res.status(400).json({ error: "Wallet not found" });
      }

      const budget = parseFloat(job.budget);
      const premiumFee = parseFloat(job.premiumAmount || "0");
      const totalCost = budget + premiumFee;
      const walletBalance = parseFloat(wallet.usdtBalance || "0");

      if (totalCost > walletBalance) {
        return res.status(400).json({ 
          error: `Insufficient balance. Need $${totalCost.toFixed(2)} (budget${premiumFee > 0 ? ` + $${premiumFee.toFixed(2)} premium fee` : ""}). Balance: $${walletBalance.toFixed(2)}.` 
        });
      }

      // Charge wallet immediately when submitting for review
      await storage.updateWallet(job.customerId, {
        usdtBalance: (walletBalance - totalCost).toFixed(8),
      });

      // Create transaction record for the charge
      await storage.createTransaction({
        walletId: wallet.id,
        type: "escrow_lock",
        currency: "USDT",
        amount: totalCost.toFixed(8),
        usdAmount: totalCost.toFixed(2),
        status: "completed",
        transactionHash: `escrow-lock-${job.id}-${Date.now()}`,
      });

      // Create escrow record
      await storage.createEscrow({
        jobId: job.id,
        customerId: job.customerId,
        totalAmount: totalCost.toFixed(2),
        status: EscrowStatus.HELD,
      });

      // Update job status to pending approval and record submission time
      const updatedJob = await storage.updateJob(req.params.id, {
        status: JobStatus.PENDING_APPROVAL,
        moderatorFeedback: null,
        submittedForReviewAt: new Date(),
      });

      // Notify moderators
      const moderators = await storage.getUsers();
      const modRoles = ["staff", "moderator", "head_of_moderation", "founder"];
      for (const mod of moderators.filter(u => modRoles.includes(u.role))) {
        await storage.createNotification({
          userId: mod.id,
          type: "moderation",
          title: "New job pending approval",
          message: `Job "${job.title}"${parseFloat(job.premiumAmount || "0") > 0 ? ` [PREMIUM $${job.premiumAmount}]` : ""} is waiting for moderation review.`,
          relatedId: job.id,
          sourceType: "system",
          sourceId: job.id,
        });
      }

      res.json(updatedJob);
    } catch (error) {
      console.error("Error submitting job for approval:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator approves job (PENDING_APPROVAL -> PENDING_ACCEPTANCE)
  app.post("/api/jobs/:id/approve", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== JobStatus.PENDING_APPROVAL && job.status !== "pending") {
        return res.status(400).json({ error: "Job is not pending approval" });
      }

      // Funds are already locked in escrow at submission time - no need to lock again here

      // Set job expiration (2 months from approval)
      const twoMonthsFromNow = new Date();
      twoMonthsFromNow.setMonth(twoMonthsFromNow.getMonth() + 2);

      // Update job status
      const updatedJob = await storage.updateJob(req.params.id, {
        status: JobStatus.PENDING_ACCEPTANCE,
        approvedAt: new Date(),
        expiresAt: twoMonthsFromNow,
        moderatorFeedback: null,
      });

      // Schedule expiration task
      await storage.createScheduledTask({
        jobId: job.id,
        taskType: "job_expiration",
        runAt: twoMonthsFromNow,
        status: ScheduledTaskStatus.PENDING,
      });

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "job_approved",
        jobId: job.id,
      });

      // Notify customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_approved",
        title: "Job approved!",
        message: `Your job "${job.title}" has been approved and is now live.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });


      res.json(updatedJob);
    } catch (error) {
      console.error("Error approving job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator rejects job
  app.post("/api/jobs/:id/reject", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== JobStatus.PENDING_APPROVAL && job.status !== "pending") {
        return res.status(400).json({ error: "Job is not pending approval" });
      }

      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string" || feedback.trim().length < 10) {
        return res.status(400).json({ error: "Please provide feedback (at least 10 characters)" });
      }

      // Refund charged funds back to wallet since job was rejected
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        const refundAmount = parseFloat(escrow.totalAmount);
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (currentBalance + refundAmount).toFixed(8),
          });
          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: refundAmount.toFixed(8),
            usdAmount: refundAmount.toFixed(2),
            status: "completed",
            transactionHash: `rejection-refund-${job.id}-${Date.now()}`,
          });
        }
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      const updatedJob = await storage.updateJob(req.params.id, {
        status: "rejected",
        moderatorFeedback: feedback.trim(),
      });

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "job_rejected",
        jobId: job.id,
        notes: feedback,
      });

      // Notify customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_rejected",
        title: "Job rejected - funds refunded",
        message: `Your job "${job.title}" was not approved. Your funds have been released back to your wallet. Please review the feedback.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      console.error("Error rejecting job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Request changes to job (PENDING_APPROVAL -> changes_requested)
  app.post("/api/jobs/:id/request-changes", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== JobStatus.PENDING_APPROVAL && job.status !== "pending") {
        return res.status(400).json({ error: "Job is not pending approval" });
      }

      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string" || feedback.trim().length < 10) {
        return res.status(400).json({ error: "Please provide feedback (at least 10 characters)" });
      }

      // Refund charged funds back to wallet - customer will re-pay when resubmitting
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        const refundAmount = parseFloat(escrow.totalAmount);
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (currentBalance + refundAmount).toFixed(8),
          });
          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: refundAmount.toFixed(8),
            usdAmount: refundAmount.toFixed(2),
            status: "completed",
            transactionHash: `changes-refund-${job.id}-${Date.now()}`,
          });
        }
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      const updatedJob = await storage.updateJob(req.params.id, {
        status: "changes_requested",
        moderatorFeedback: feedback.trim(),
      });

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "job_changes_requested",
        jobId: job.id,
        notes: feedback,
      });

      // Notify customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_changes_requested",
        title: "Job changes requested - funds refunded",
        message: `A moderator has requested changes to your job "${job.title}". Your funds have been released back to your wallet.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      console.error("Error requesting changes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Freelancer submits work (creates submission with proof)
  app.post("/api/jobs/:id/submit-work", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is assigned to this job
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can submit work" });
      }

      // Only the Project Leader may submit work on behalf of the whole team.
      // The first freelancer to take the job is the leader unless a vote changed it.
      const projectLeaderId = job.projectLeaderId || job.freelancerId;
      if (req.session.userId !== projectLeaderId) {
        return res.status(403).json({ error: "Only the Project Leader can submit work for this job" });
      }

      // Job must be in progress (legacy: claimed, in_progress or new: IN_PROGRESS)
      const inProgressStatuses = ["claimed", "in_progress", JobStatus.IN_PROGRESS];
      if (!inProgressStatuses.includes(job.status)) {
        return res.status(400).json({ error: "Job must be in progress to submit work" });
      }

      const { proofFiles, proofLinks, notes } = req.body;

      // Require at least some proof
      const hasProof = (proofFiles && proofFiles.length > 0) || (proofLinks && proofLinks.length > 0) || notes;
      if (!hasProof) {
        return res.status(400).json({ error: "Please provide proof of work (files, links, or notes)" });
      }

      // Create job submission
      const submission = await storage.createJobSubmission({
        jobId: job.id,
        freelancerId: req.session.userId!,
        proofFiles: proofFiles || [],
        proofLinks: proofLinks || [],
        notes: notes || null,
        status: JobSubmissionStatus.SUBMITTED,
      });

      // Set 4-day auto-complete timer
      const autoCompleteDate = new Date();
      autoCompleteDate.setDate(autoCompleteDate.getDate() + 4);

      // Update job status
      await storage.updateJob(job.id, {
        status: JobStatus.AWAITING_CUSTOMER,
        submittedAt: new Date(),
        autoCompleteAt: autoCompleteDate,
      });

      // Schedule auto-complete task
      await storage.createScheduledTask({
        jobId: job.id,
        taskType: "auto_complete",
        runAt: autoCompleteDate,
        status: ScheduledTaskStatus.PENDING,
        metadata: { submissionId: submission.id },
      });

      // Schedule 8-hour reminder
      const reminderDate = new Date();
      reminderDate.setHours(reminderDate.getHours() + 8);
      await storage.createScheduledTask({
        jobId: job.id,
        taskType: "customer_reminder",
        runAt: reminderDate,
        status: ScheduledTaskStatus.PENDING,
      });

      // Notify customer
      await storage.createNotification({
        userId: job.customerId,
        type: "work_submitted",
        title: "Work submitted for review",
        message: `Freelancer has submitted work for "${job.title}". Please review within 4 days.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(submission);
    } catch (error) {
      console.error("Error submitting work:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get job submissions
  app.get("/api/jobs/:id/submissions", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only job owner, assigned freelancer, or moderators can see submissions
      const user = await storage.getUser(req.session.userId!);
      const isAssigned = job.freelancerId === req.session.userId ||
        job.customerId === req.session.userId ||
        ["staff", "moderator", "head_of_moderation", "founder"].includes(user?.role || "");

      if (!isAssigned) {
        return res.status(403).json({ error: "Not authorized to view submissions" });
      }

      const submissions = await storage.getJobSubmissions(job.id);
      res.json(submissions);
    } catch (error) {
      console.error("Error getting submissions:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer accepts work (AWAITING_CUSTOMER -> COMPLETED)
  app.post("/api/jobs/:id/accept-work", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can accept work" });
      }

      if (job.status !== JobStatus.AWAITING_CUSTOMER) {
        return res.status(400).json({ error: "Job is not awaiting customer review" });
      }

      // Get latest submission
      const submissions = await storage.getJobSubmissions(job.id);
      if (submissions.length === 0) {
        return res.status(400).json({ error: "No submission found" });
      }

      const latestSubmission = submissions[0];

      // Create customer review record
      await storage.createCustomerReview({
        jobId: job.id,
        submissionId: latestSubmission.id,
        customerId: req.session.userId!,
        accepted: true,
      });

      // Update submission status
      await storage.updateJobSubmission(latestSubmission.id, {
        status: "accepted",
      });

      // Cancel scheduled auto-complete task
      const scheduledTasks = await storage.getScheduledTasks({ jobId: job.id, taskType: "auto_complete" });
      for (const task of scheduledTasks) {
        await storage.updateScheduledTask(task.id, { status: "cancelled" });
      }

      // Release escrow and pay freelancers
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow) {
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.RELEASED });
      }

      // Get all freelancers on this job (lead + collaborators + job_freelancers)
      const allFreelancerIds = await getJobFreelancerIds(job);

      const budget = parseFloat(job.budget);
      const jobPremium = parseFloat(job.premiumAmount || "0");
      const totalCost = budget + jobPremium;
      const numFreelancers = allFreelancerIds.length;
      const sharePerFreelancer = numFreelancers > 0 ? budget / numFreelancers : 0;

      // Funds already deducted from customer wallet at submission time
      // Just release escrow and pay freelancers
      const escrow2 = await storage.getEscrowByJob(job.id);
      if (escrow2 && escrow2.status === EscrowStatus.HELD) {
        await storage.updateEscrow(escrow2.id, { status: EscrowStatus.RELEASED });
      }

      // Pay each freelancer based on their level
      for (const freelancerId of allFreelancerIds) {
        const freelancer = await storage.getUser(freelancerId);
        if (!freelancer) continue;

        const level = freelancer.level || 1;
        const levelPayout = getLevelPayout(level); // Returns 0.65 to 0.97
        const payoutAmount = sharePerFreelancer * levelPayout;
        const platformFee = sharePerFreelancer - payoutAmount;

        const freelancerWallet = await storage.getWallet(freelancerId);
        if (freelancerWallet) {
          const freelancerBalance = parseFloat(freelancerWallet.usdtBalance || "0");
          await storage.updateWallet(freelancerId, {
            usdtBalance: (freelancerBalance + payoutAmount).toFixed(8),
          });

          await storage.createTransaction({
            walletId: freelancerWallet.id,
            type: "deposit",
            currency: "USDT",
            amount: payoutAmount.toFixed(8),
            usdAmount: payoutAmount.toFixed(2),
            status: "completed",
            transactionHash: `job-payment-${job.id}-${freelancerId}`,
          });
        }

        // Update job freelancer record if exists
        const jfRecords = await storage.getJobFreelancers(job.id);
        const jfRecord = jfRecords.find(jf => jf.freelancerId === freelancerId);
        if (jfRecord) {
          await storage.updateJobFreelancer(jfRecord.id, {
            payoutAmount: payoutAmount.toFixed(2),
            status: "paid",
          });
        }

        // Notify freelancer
        await storage.createNotification({
          userId: freelancerId,
          type: "job_completed",
          title: "Payment received!",
          message: `You received $${payoutAmount.toFixed(2)} for completing "${job.title}".`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      // Mark job as completed FIRST (before updating stats)
      const updatedJob = await storage.updateJob(job.id, {
        status: JobStatus.COMPLETED,
      });

      // NOW update freelancer stats after job is marked completed (increment completed count)
      for (const freelancerId of allFreelancerIds) {
        const fl = await storage.getUser(freelancerId);
        const earnedIncrement = sharePerFreelancer * getLevelPayout(fl?.level || 1);
        await updateFreelancerStats(freelancerId, true, earnedIncrement);
      }

      res.json(updatedJob);
    } catch (error) {
      console.error("Error accepting work:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer rejects work (AWAITING_CUSTOMER -> SUBMITTED with rejection)
  app.post("/api/jobs/:id/reject-work", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can reject work" });
      }

      if (job.status !== JobStatus.AWAITING_CUSTOMER) {
        return res.status(400).json({ error: "Job is not awaiting customer review" });
      }

      const { reason } = req.body;
      if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Please provide a reason for rejection (at least 10 characters)" });
      }

      // Get latest submission
      const submissions = await storage.getJobSubmissions(job.id);
      if (submissions.length === 0) {
        return res.status(400).json({ error: "No submission found" });
      }

      const latestSubmission = submissions[0];

      // Create customer review record
      await storage.createCustomerReview({
        jobId: job.id,
        submissionId: latestSubmission.id,
        customerId: req.session.userId!,
        accepted: false,
        rejectionReason: reason.trim(),
      });

      // Update submission status
      await storage.updateJobSubmission(latestSubmission.id, {
        status: "rejected",
      });

      // Cancel scheduled auto-complete task
      const scheduledTasks = await storage.getScheduledTasks({ jobId: job.id, taskType: "auto_complete" });
      for (const task of scheduledTasks) {
        await storage.updateScheduledTask(task.id, { status: "cancelled" });
      }

      // Update job back to in_progress
      await storage.updateJob(job.id, {
        status: "in_progress",
        autoCompleteAt: null,
      });

      // Notify freelancer
      if (job.freelancerId) {
        await storage.createNotification({
          userId: job.freelancerId,
          type: "work_rejected",
          title: "Work not accepted",
          message: `Your work for "${job.title}" was not accepted. Reason: ${reason.trim().substring(0, 100)}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json({ success: true, message: "Work rejected. Freelancer can resubmit." });
    } catch (error) {
      console.error("Error rejecting work:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Helper function to update freelancer stats
  async function updateFreelancerStats(freelancerId: string, incrementCompleted: boolean = false, earnedIncrement: number = 0) {
    const freelancer = await storage.getUser(freelancerId);
    if (!freelancer) return;

    // Counter-based completion rate: completedJobs / totalJobs (lifetime finished jobs).
    let completedJobs = freelancer.completedJobs || 0;
    let totalJobs = freelancer.totalJobs || 0;

    // If incrementing (job just completed), add 1 to both counters.
    if (incrementCompleted) {
      completedJobs = completedJobs + 1;
      totalJobs = totalJobs + 1;
    }

    const completionPercentage = totalJobs > 0
      ? ((completedJobs / totalJobs) * 100).toFixed(2)
      : "0.00";

    // Level is based on lifetime earnings, not completed jobs.
    const totalEarned = parseFloat(freelancer.totalEarned || "0") + earnedIncrement;
    const newLevel = getLevelFromEarnings(totalEarned);

    await storage.updateUser(freelancerId, {
      completedJobs,
      totalJobs,
      completionPercentage,
      totalEarned: totalEarned.toFixed(2),
      level: newLevel,
    });
  }

  // Lower a freelancer's completion rate when a job ends without completion
  // (cancelled by agreement or resolved against them in a dispute).
  async function penalizeFreelancerCompletion(freelancerId: string) {
    const freelancer = await storage.getUser(freelancerId);
    if (!freelancer) return;

    const completedJobs = freelancer.completedJobs || 0;
    const totalJobs = (freelancer.totalJobs || 0) + 1;
    const completionPercentage = totalJobs > 0
      ? ((completedJobs / totalJobs) * 100).toFixed(2)
      : "0.00";

    await storage.updateUser(freelancerId, {
      totalJobs,
      completionPercentage,
    });
  }

  // Penalize every freelancer assigned to a job (lead + collaborators + team
  // members) when the job ends cancelled without completion.
  async function penalizeAllJobFreelancers(job: any) {
    const freelancerIds = await getJobFreelancerIds(job);
    for (const id of freelancerIds) {
      await penalizeFreelancerCompletion(id);
    }
  }

  // ============================================================
  // DISPUTE ROUTES
  // ============================================================

  // Open a dispute
  app.post("/api/jobs/:id/dispute", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only customer or assigned freelancer can open dispute
      const isAuthorized = job.customerId === req.session.userId || 
        job.freelancerId === req.session.userId;
      
      if (!isAuthorized) {
        return res.status(403).json({ error: "Only job participants can open disputes" });
      }

      // Job must be in an active state
      const activeStatuses = ["claimed", "in_progress", JobStatus.AWAITING_CUSTOMER, JobStatus.SUBMITTED];
      if (!activeStatuses.includes(job.status)) {
        return res.status(400).json({ error: "Cannot open dispute for job in current state" });
      }

      // Check if dispute already exists
      const existingDispute = await storage.getDisputeByJob(job.id);
      if (existingDispute && existingDispute.status !== DisputeStatus.RESOLVED) {
        return res.status(400).json({ error: "A dispute is already open for this job" });
      }

      const { reason, category } = req.body;
      if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Please provide a reason for the dispute (at least 10 characters)" });
      }

      // Create dispute
      const dispute = await storage.createDispute({
        jobId: job.id,
        openedByUserId: req.session.userId!,
        reason: reason.trim(),
        category: typeof category === "string" && category.trim() ? category.trim() : null,
      });

      // Lock the job and remember its pre-dispute status so closing the dispute can restore it
      await storage.updateJob(job.id, {
        status: JobStatus.DISPUTE,
        isLocked: true,
        preDisputeStatus: job.status,
      });

      // Cancel any pending scheduled tasks
      const scheduledTasks = await storage.getScheduledTasks({ jobId: job.id });
      for (const task of scheduledTasks) {
        if (task.status === ScheduledTaskStatus.PENDING) {
          await storage.updateScheduledTask(task.id, { status: "cancelled" });
        }
      }

      // Notify the other party
      const otherPartyId = job.customerId === req.session.userId ? job.freelancerId : job.customerId;
      if (otherPartyId) {
        await storage.createNotification({
          userId: otherPartyId,
          type: "dispute_opened",
          title: "Dispute opened",
          message: `A dispute has been opened for "${job.title}". A moderator will review.`,
          relatedId: job.id,
          sourceType: "dispute",
          sourceId: dispute.id,
        });
      }

      // Notify moderators
      const moderators = await storage.getUsers();
      const modRoles = ["staff", "moderator", "head_of_moderation", "founder"];
      for (const mod of moderators.filter(u => modRoles.includes(u.role))) {
        await storage.createNotification({
          userId: mod.id,
          type: "dispute_opened",
          title: "New dispute requires attention",
          message: `A dispute has been opened for job "${job.title}".`,
          relatedId: dispute.id,
          sourceType: "dispute",
          sourceId: dispute.id,
        });
      }

      res.json(dispute);
    } catch (error) {
      console.error("Error opening dispute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get disputes (for moderators)
  // Get disputes claimed by the current moderator
  app.get("/api/disputes/mine", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const allDisputes = await storage.getDisputes();
      const myDisputes = allDisputes.filter(d => d.moderatorId === req.session.userId);

      // Enrich with job and user data
      const enrichedDisputes = await Promise.all(
        myDisputes.map(async (dispute) => {
          const job = await storage.getJob(dispute.jobId);
          const openedBy = await storage.getUser(dispute.openedByUserId);
          const customer = job ? await storage.getUser(job.customerId) : null;
          const freelancer = job?.freelancerId ? await storage.getUser(job.freelancerId) : null;

          return {
            ...dispute,
            jobTitle: job?.title,
            jobBudget: job?.budget,
            openedByUsername: openedBy?.username,
            openedByUserRole: openedBy?.role || null,
            customerUsername: customer?.username,
            customerId: job?.customerId,
            freelancerUsername: freelancer?.username,
            freelancerId: job?.freelancerId,
          };
        })
      );

      res.json(enrichedDisputes);
    } catch (error) {
      console.error("Error getting my disputes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/disputes", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { status } = req.query;
      const disputes = await storage.getDisputes(status ? { status: status as string } : undefined);

      // Enrich with job and user data
      const enrichedDisputes = await Promise.all(
        disputes.map(async (dispute) => {
          const job = await storage.getJob(dispute.jobId);
          const openedBy = await storage.getUser(dispute.openedByUserId);
          const moderator = dispute.moderatorId ? await storage.getUser(dispute.moderatorId) : null;

          return {
            ...dispute,
            jobBudget: job?.budget || null,
            jobTitle: job?.title || null,
            job: job ? { id: job.id, title: job.title, budget: job.budget, customerId: job.customerId, freelancerId: job.freelancerId } : null,
            openedBy: openedBy ? { id: openedBy.id, username: openedBy.username, role: openedBy.role } : null,
            openedByUsername: openedBy?.username || null,
            openedByUserRole: openedBy?.role || null,
            moderator: moderator ? { id: moderator.id, username: moderator.username } : null,
          };
        })
      );

      res.json(enrichedDisputes);
    } catch (error) {
      console.error("Error getting disputes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Claim dispute (moderator takes ownership)
  app.post("/api/disputes/:id/claim", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const dispute = await storage.getDispute(req.params.id);
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found" });
      }

      if (dispute.status !== DisputeStatus.OPEN) {
        return res.status(400).json({ error: "Dispute is not open" });
      }

      if (dispute.moderatorId) {
        return res.status(400).json({ error: "Dispute already claimed by another moderator" });
      }

      const updatedDispute = await storage.updateDispute(req.params.id, {
        moderatorId: req.session.userId!,
        status: DisputeStatus.UNDER_REVIEW,
      });

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "dispute_claimed",
        disputeId: dispute.id,
        jobId: dispute.jobId,
      });

      res.json(updatedDispute);
    } catch (error) {
      console.error("Error claiming dispute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Relinquish dispute (unclaim - put back in queue)
  app.post("/api/disputes/:id/relinquish", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const dispute = await storage.getDispute(req.params.id);
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found" });
      }

      if (dispute.moderatorId !== req.session.userId) {
        return res.status(403).json({ error: "You can only relinquish disputes you have claimed" });
      }

      const updatedDispute = await storage.updateDispute(req.params.id, {
        moderatorId: null,
        status: DisputeStatus.OPEN,
      });

      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "dispute_relinquished",
        disputeId: dispute.id,
        jobId: dispute.jobId,
      });

      res.json(updatedDispute);
    } catch (error) {
      console.error("Error relinquishing dispute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Close dispute without distributing funds (keep job going)
  app.post("/api/disputes/:id/close", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const dispute = await storage.getDispute(req.params.id);
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found" });
      }

      if (dispute.status === DisputeStatus.RESOLVED) {
        return res.status(400).json({ error: "Dispute already resolved" });
      }

      if (dispute.status === DisputeStatus.OPEN) {
        return res.status(400).json({ error: "Claim this dispute before closing it" });
      }

      const isLeadership = ["staff", "head_of_moderation", "founder"].includes(req.session.userRole || "");
      if (dispute.moderatorId && dispute.moderatorId !== req.session.userId && !isLeadership) {
        return res.status(403).json({ error: "This dispute is handled by another moderator" });
      }

      const job = await storage.getJob(dispute.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Update dispute to resolved (closed without distribution)
      await storage.updateDispute(req.params.id, {
        status: DisputeStatus.RESOLVED,
        freelancerAmount: "0.00",
        customerRefund: "0.00",
        resolutionNotes: req.body.resolutionNotes?.trim() || "Dispute closed without action — job continues.",
      });

      // Unlock the job and return it to how it was before the dispute was opened
      await storage.updateJob(job.id, {
        status: (job.preDisputeStatus as any) || JobStatus.IN_PROGRESS,
        isLocked: false,
        preDisputeStatus: null,
      });

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "dispute_closed",
        disputeId: dispute.id,
        jobId: job.id,
        notes: req.body.resolutionNotes?.trim() || "Dispute closed without action — job continues.",
      });

      // Notify the customer and every assigned freelancer
      if (job.customerId) {
        await storage.createNotification({
          userId: job.customerId,
          type: "dispute_closed",
          title: "Dispute closed",
          message: `The dispute for "${job.title}" has been closed. The job continues as normal.`,
        });
      }
      for (const fid of await getJobFreelancerIds(job)) {
        await storage.createNotification({
          userId: fid,
          type: "dispute_closed",
          title: "Dispute closed",
          message: `The dispute for "${job.title}" has been closed. The job continues as normal.`,
        });
      }

      res.json({ success: true, message: "Dispute closed. Job continues as normal." });
    } catch (error) {
      console.error("Error closing dispute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Resolve dispute
  app.post("/api/disputes/:id/resolve", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const dispute = await storage.getDispute(req.params.id);
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found" });
      }

      if (dispute.status === DisputeStatus.RESOLVED) {
        return res.status(400).json({ error: "Dispute already resolved" });
      }

      if (dispute.status === DisputeStatus.OPEN) {
        return res.status(400).json({ error: "Claim this dispute before resolving it" });
      }

      const isLeadership = ["staff", "head_of_moderation", "founder"].includes(req.session.userRole || "");
      if (dispute.moderatorId && dispute.moderatorId !== req.session.userId && !isLeadership) {
        return res.status(403).json({ error: "This dispute is handled by another moderator" });
      }

      const { freelancerAmount, customerRefund, resolutionNotes } = req.body;

      if (typeof freelancerAmount !== "number" || typeof customerRefund !== "number") {
        return res.status(400).json({ error: "Please specify freelancer and customer amounts" });
      }

      if (freelancerAmount < 0 || customerRefund < 0) {
        return res.status(400).json({ error: "Amounts cannot be negative. Both amounts must be zero or positive." });
      }

      if (!resolutionNotes || typeof resolutionNotes !== "string" || resolutionNotes.trim().length < 10) {
        return res.status(400).json({ error: "Please provide resolution notes (at least 10 characters)" });
      }

      const job = await storage.getJob(dispute.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const budget = parseFloat(job.budget);
      const jobPremium = parseFloat(job.premiumAmount || "0");
      const totalCost = budget + jobPremium;

      // The full budget must be distributed between the freelancer and the customer,
      // so the moderator cannot keep money out of the dispute. (Premium stays with Linxova.)
      if (Math.abs(freelancerAmount + customerRefund - budget) > 0.01) {
        return res.status(400).json({
          error: `The full job budget must be distributed. Freelancer amount + customer refund must total exactly $${budget.toFixed(2)}.`
        });
      }

      // Freelancer payouts are reduced by the platform fee based on their level.
      const freelancerUser = job.freelancerId ? await storage.getUser(job.freelancerId) : null;
      const freelancerLevel = freelancerUser?.level || 1;
      const levelPayout = getLevelPayout(freelancerLevel);
      const freelancerNetPayout = freelancerAmount * levelPayout; // platform keeps the difference

      // Get escrow
      const escrow = await storage.getEscrowByJob(job.id);
      if (!escrow) {
        return res.status(400).json({ error: "Escrow not found" });
      }

      // Update dispute
      const updatedDispute = await storage.updateDispute(req.params.id, {
        status: DisputeStatus.RESOLVED,
        freelancerAmount: freelancerAmount.toFixed(2),
        customerRefund: customerRefund.toFixed(2),
        resolutionNotes: resolutionNotes.trim(),
      });

      // Funds already deducted from customer wallet at submission time
      // Only refund the customerRefund portion back to wallet (premium stays with Linxova)
      if (customerRefund > 0) {
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const customerBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (customerBalance + customerRefund).toFixed(8),
          });

          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: customerRefund.toFixed(8),
            usdAmount: customerRefund.toFixed(2),
            status: "completed",
            transactionHash: `dispute-refund-${dispute.id}`,
          });
        }
      }

      // Pay every freelancer on the job (project leader + collaborators +
      // jobFreelancers) an equal share of the allocated amount, each net of the
      // platform fee based on their own level.
      if (freelancerAmount > 0) {
        const allFreelancerIds = await getJobFreelancerIds(job);
        const share = freelancerAmount / allFreelancerIds.length;
        for (const fid of allFreelancerIds) {
          const fu = await storage.getUser(fid);
          const fuLevel = fu?.level || 1;
          const fuNet = share * getLevelPayout(fuLevel);
          if (fuNet <= 0) continue;
          const fw = await storage.getWallet(fid);
          if (!fw) continue;
          const fb = parseFloat(fw.usdtBalance || "0");
          await storage.updateWallet(fid, {
            usdtBalance: (fb + fuNet).toFixed(8),
          });

          await storage.createTransaction({
            walletId: fw.id,
            type: "deposit",
            currency: "USDT",
            amount: fuNet.toFixed(8),
            usdAmount: fuNet.toFixed(2),
            status: "completed",
            transactionHash: `dispute-payout-${dispute.id}-${fid}`,
          });
        }
      }

      // Dispute payouts count toward lifetime earnings used for leveling
      // (no job-completion counter changes).
      const allFreelancerIdsPayout = await getJobFreelancerIds(job);
      const payoutShare = freelancerAmount / allFreelancerIdsPayout.length;
      for (const fid of allFreelancerIdsPayout) {
        await updateFreelancerStats(fid, false, payoutShare);
      }

      // Notify every freelancer on the job
      for (const fid of allFreelancerIdsPayout) {
        const fu = await storage.getUser(fid);
        const fuLevel = fu?.level || 1;
        const fuNet = payoutShare * getLevelPayout(fuLevel);
        await storage.createNotification({
          userId: fid,
          type: "dispute_resolved",
          title: "Dispute resolved",
          message: `The dispute for "${job.title}" has been resolved. Your share: $${fuNet.toFixed(2)} after the platform fee.`,
          relatedId: job.id,
          sourceType: "dispute",
          sourceId: dispute.id,
        });
      }

      // Update escrow
      await storage.updateEscrow(escrow.id, { status: EscrowStatus.RELEASED });

      // Update job status
      await storage.updateJob(job.id, {
        status: JobStatus.CANCELLED,
        isLocked: false,
        preDisputeStatus: null,
      });

      // A cancelled/resolved-against job counts against every assigned freelancer's completion rate
      // unless the moderator opted to leave completion rates unaffected.
      const affectCompletionRate = req.body.affectCompletionRate !== false;
      if (affectCompletionRate) {
        await penalizeAllJobFreelancers(job);
      }

      // Log moderation action
      await storage.createModerationLog({
        moderatorId: req.session.userId!,
        actionType: "dispute_resolved",
        disputeId: dispute.id,
        jobId: job.id,
        notes: `Freelancer: $${freelancerAmount} (net $${freelancerNetPayout.toFixed(2)} after level fee), Customer refund: $${customerRefund}`,
      });

      // Notify both parties
      await storage.createNotification({
        userId: job.customerId,
        type: "dispute_resolved",
        title: "Dispute resolved",
        message: `The dispute for "${job.title}" has been resolved. You received a refund of $${customerRefund}.`,
        relatedId: job.id,
        sourceType: "dispute",
        sourceId: dispute.id,
      });

      res.json(updatedDispute);
    } catch (error) {
      console.error("Error resolving dispute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================================
  // CANCELLATION ROUTES
  // ============================================================

  // Cancel job before freelancer acceptance (full refund)
  app.post("/api/jobs/:id/cancel-before-acceptance", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can cancel" });
      }

      // Can only cancel before freelancer accepts (PENDING_ACCEPTANCE, or old "active" status)
      if (job.status !== JobStatus.PENDING_ACCEPTANCE && job.status !== "active") {
        return res.status(400).json({ error: "Job can only be cancelled before a freelancer accepts" });
      }

      // Refund escrow
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow) {
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      // Credit full refund back to wallet (budget + premium)
      const budget = parseFloat(job.budget);
      const jobPremium = parseFloat(job.premiumAmount || "0");
      const totalRefund = budget + jobPremium;

      const customerWallet = await storage.getWallet(job.customerId);
      if (customerWallet) {
        const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
        await storage.updateWallet(job.customerId, {
          usdtBalance: (currentBalance + totalRefund).toFixed(8),
        });
        await storage.createTransaction({
          walletId: customerWallet.id,
          type: "refund",
          currency: "USDT",
          amount: totalRefund.toFixed(8),
          usdAmount: totalRefund.toFixed(2),
          status: "completed",
          transactionHash: `job-cancel-refund-${job.id}`,
        });
      }

      // Cancel any pending scheduled tasks
      const scheduledTasks = await storage.getScheduledTasks({ jobId: job.id });
      for (const task of scheduledTasks) {
        if (task.status === ScheduledTaskStatus.PENDING) {
          await storage.updateScheduledTask(task.id, { status: "cancelled" });
        }
      }

      // Update job status
      const updatedJob = await storage.updateJob(job.id, {
        status: JobStatus.CANCELLED,
      });

      // Notify customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_cancelled",
        title: "Job cancelled",
        message: `Your job "${job.title}" has been cancelled. Full refund of $${totalRefund.toFixed(2)} processed.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      console.error("Error cancelling job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Initiate cancellation after freelancer acceptance (starts 7-day negotiation)
  app.post("/api/jobs/:id/initiate-cancellation", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only customer or freelancer can initiate
      const isParticipant = job.customerId === req.session.userId || job.freelancerId === req.session.userId;
      if (!isParticipant) {
        return res.status(403).json({ error: "Only job participants can initiate cancellation" });
      }

      // Must be after acceptance (claimed or in_progress)
      if (job.status !== "claimed" && job.status !== "in_progress") {
        return res.status(400).json({ error: "Job must be in progress to initiate cancellation" });
      }

      // Check for existing negotiation
      const existing = await storage.getCancellationNegotiationByJob(job.id);
      if (existing && existing.status === "negotiating") {
        return res.status(400).json({ error: "Cancellation negotiation already in progress" });
      }

      const { proposedFreelancerAmount, proposedCustomerRefund } = req.body;
      const budget = parseFloat(job.budget);

      // Validate amounts
      if (typeof proposedFreelancerAmount !== "number" || typeof proposedCustomerRefund !== "number") {
        return res.status(400).json({ error: "Please specify proposed amounts" });
      }

      if (proposedFreelancerAmount + proposedCustomerRefund > budget) {
        return res.status(400).json({ error: "Total amounts cannot exceed job budget" });
      }

      // Create negotiation with 7-day expiry
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const initiatorIsCustomer = job.customerId === req.session.userId;

      const negotiation = await storage.createCancellationNegotiation({
        jobId: job.id,
        initiatedById: req.session.userId!,
        proposedFreelancerAmount: proposedFreelancerAmount.toFixed(2),
        proposedCustomerRefund: proposedCustomerRefund.toFixed(2),
        agreedByCustomer: initiatorIsCustomer,
        agreedByFreelancer: !initiatorIsCustomer,
        expiresAt,
        status: "negotiating",
      });

      // Schedule escalation task
      await storage.createScheduledTask({
        jobId: job.id,
        taskType: "cancellation_escalation",
        runAt: expiresAt,
        status: ScheduledTaskStatus.PENDING,
        metadata: { negotiationId: negotiation.id },
      });

      // Notify other party
      const otherPartyId = initiatorIsCustomer ? job.freelancerId : job.customerId;
      if (otherPartyId) {
        await storage.createNotification({
          userId: otherPartyId,
          type: "cancellation_proposed",
          title: "Cancellation proposed",
          message: `A cancellation has been proposed for "${job.title}". You have 7 days to agree or negotiate.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json(negotiation);
    } catch (error) {
      console.error("Error initiating cancellation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Agree to cancellation proposal
  app.post("/api/jobs/:id/agree-cancellation", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const negotiation = await storage.getCancellationNegotiationByJob(job.id);
      if (!negotiation || negotiation.status !== "negotiating") {
        return res.status(400).json({ error: "No active cancellation negotiation" });
      }

      const isCustomer = job.customerId === req.session.userId;
      const isFreelancer = job.freelancerId === req.session.userId;

      if (!isCustomer && !isFreelancer) {
        return res.status(403).json({ error: "Only job participants can agree to cancellation" });
      }

      // Update agreement
      const updates: any = {
        agreedByCustomer: negotiation.agreedByCustomer || isCustomer,
        agreedByFreelancer: negotiation.agreedByFreelancer || isFreelancer,
      };

      // Check if both parties agree
      if (updates.agreedByCustomer && updates.agreedByFreelancer) {
        updates.status = "agreed";

        // Process the cancellation
        const freelancerAmount = parseFloat(negotiation.proposedFreelancerAmount || "0");
        const customerRefund = parseFloat(negotiation.proposedCustomerRefund || "0");
        const budget = parseFloat(job.budget);

        // Update escrow
        const escrow = await storage.getEscrowByJob(job.id);
        if (escrow) {
          await storage.updateEscrow(escrow.id, { status: EscrowStatus.RELEASED });
        }

        // Funds already deducted at submission time
        // Only refund the customerRefund portion back to wallet
        if (customerRefund > 0) {
          const customerWallet = await storage.getWallet(job.customerId);
          if (customerWallet) {
            const customerBalance = parseFloat(customerWallet.usdtBalance || "0");
            await storage.updateWallet(job.customerId, {
              usdtBalance: (customerBalance + customerRefund).toFixed(8),
            });

            await storage.createTransaction({
              walletId: customerWallet.id,
              type: "refund",
              currency: "USDT",
              amount: customerRefund.toFixed(8),
              usdAmount: customerRefund.toFixed(2),
              status: "completed",
              transactionHash: `cancel-refund-${job.id}`,
            });
          }
        }

        if (job.freelancerId && freelancerAmount > 0) {
          const freelancerWallet = await storage.getWallet(job.freelancerId);
          if (freelancerWallet) {
            const freelancerBalance = parseFloat(freelancerWallet.usdtBalance || "0");
            await storage.updateWallet(job.freelancerId, {
              usdtBalance: (freelancerBalance + freelancerAmount).toFixed(8),
            });

            await storage.createTransaction({
              walletId: freelancerWallet.id,
              type: "deposit",
              currency: "USDT",
              amount: freelancerAmount.toFixed(8),
              usdAmount: freelancerAmount.toFixed(2),
              status: "completed",
              transactionHash: `cancel-payout-${job.id}`,
            });
          }
        }

        // Cancel scheduled tasks
        const scheduledTasks = await storage.getScheduledTasks({ jobId: job.id });
        for (const task of scheduledTasks) {
          if (task.status === ScheduledTaskStatus.PENDING) {
            await storage.updateScheduledTask(task.id, { status: "cancelled" });
          }
        }

        // Update job
        await storage.updateJob(job.id, {
          status: JobStatus.CANCELLED,
        });

        // A cancelled job counts against every assigned freelancer's completion rate.
        await penalizeAllJobFreelancers(job);

        // Notify both parties
        await storage.createNotification({
          userId: job.customerId,
          type: "job_cancelled",
          title: "Job cancelled by agreement",
          message: `"${job.title}" has been cancelled. You received $${customerRefund}.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });

        if (job.freelancerId) {
          await storage.createNotification({
            userId: job.freelancerId,
            type: "job_cancelled",
            title: "Job cancelled by agreement",
            message: `"${job.title}" has been cancelled. You received $${freelancerAmount}.`,
            relatedId: job.id,
            sourceType: "job",
            sourceId: job.id,
          });
        }
      }

      const updatedNegotiation = await storage.updateCancellationNegotiation(negotiation.id, updates);
      res.json(updatedNegotiation);
    } catch (error) {
      console.error("Error agreeing to cancellation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get cancellation negotiation for a job
  app.get("/api/jobs/:id/cancellation-negotiation", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only participants or moderators can view
      const user = await storage.getUser(req.session.userId!);
      const isParticipant = job.customerId === req.session.userId || job.freelancerId === req.session.userId;
      const isModerator = ["staff", "moderator", "head_of_moderation", "founder"].includes(user?.role || "");

      if (!isParticipant && !isModerator) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const negotiation = await storage.getCancellationNegotiationByJob(job.id);
      res.json(negotiation || null);
    } catch (error) {
      console.error("Error getting cancellation negotiation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get escrow for a job
  app.get("/api/jobs/:id/escrow", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only participants or moderators can view escrow
      const user = await storage.getUser(req.session.userId!);
      const isParticipant = job.customerId === req.session.userId || job.freelancerId === req.session.userId;
      const isModerator = ["staff", "moderator", "head_of_moderation", "founder"].includes(user?.role || "");

      if (!isParticipant && !isModerator) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const escrow = await storage.getEscrowByJob(job.id);
      res.json(escrow || null);
    } catch (error) {
      console.error("Error getting escrow:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Team collaboration routes - Team Notes
  app.get("/api/team-notes/:jobId", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team (freelancer, collaborator, or customer)
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const notes = await storage.getTeamNotes(req.params.jobId);
      const enrichedNotes = await Promise.all(
        notes.map(async (note) => {
          const author = await storage.getUser(note.authorId);
          return {
            ...note,
            authorUsername: author?.username || null,
            authorAvatar: author?.avatar || null,
          };
        })
      );
      res.json(enrichedNotes);
    } catch (error) {
      console.error("Error fetching team notes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/team-notes", requireAuth, async (req, res) => {
    try {
      // Validate without authorId (will be set from session)
      const { jobId, content } = insertTeamNoteSchema.omit({ authorId: true }).parse(req.body);
      
      const job = await storage.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const note = await storage.createTeamNote({
        jobId,
        content,
        authorId: req.session.userId!,
      });

      res.status(201).json(note);
    } catch (error) {
      console.error("Error creating team note:", error);
      res.status(400).json({ error: "Invalid note data" });
    }
  });

  app.put("/api/team-notes/:id", requireAuth, async (req, res) => {
    try {
      // Fetch ALL team notes to find this specific note
      // This is inefficient but necessary with current storage interface
      let existingNote: any = null;
      
      // Try to find the note by checking all jobs (not ideal, but works with current API)
      // In production, we'd add a getTeamNoteById method to IStorage
      const allJobs = await storage.getJobs();
      for (const job of allJobs) {
        const notes = await storage.getTeamNotes(job.id);
        const found = notes.find(n => n.id === req.params.id);
        if (found) {
          existingNote = found;
          break;
        }
      }
      
      if (!existingNote) {
        return res.status(404).json({ error: "Note not found" });
      }

      // Now verify user is part of the team using the REAL jobId from the note
      const job = await storage.getJob(existingNote.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      // Only allow updating content
      const note = await storage.updateTeamNote(req.params.id, { 
        content: req.body.content 
      });
      
      res.json(note);
    } catch (error) {
      console.error("Error updating team note:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/team-notes/:id", requireAuth, async (req, res) => {
    try {
      // Fetch the note first to get its real jobId
      let existingNote: any = null;
      const allJobs = await storage.getJobs();
      for (const job of allJobs) {
        const notes = await storage.getTeamNotes(job.id);
        const found = notes.find(n => n.id === req.params.id);
        if (found) {
          existingNote = found;
          break;
        }
      }
      
      if (!existingNote) {
        return res.status(404).json({ error: "Note not found" });
      }

      // Verify user is part of the team using the REAL jobId
      const job = await storage.getJob(existingNote.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      await storage.deleteTeamNote(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting team note:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Team collaboration routes - Team Tasks
  app.get("/api/team-tasks/:jobId", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const tasks = await storage.getTeamTasks(req.params.jobId);
      res.json(tasks);
    } catch (error) {
      console.error("Error fetching team tasks:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/team-tasks", requireAuth, async (req, res) => {
    try {
      const validatedTask = insertTeamTaskSchema.parse(req.body);
      
      const job = await storage.getJob(validatedTask.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const task = await storage.createTeamTask(validatedTask);
      res.status(201).json(task);
    } catch (error) {
      console.error("Error creating team task:", error);
      res.status(400).json({ error: "Invalid task data" });
    }
  });

  app.put("/api/team-tasks/:id", requireAuth, async (req, res) => {
    try {
      // Validate update payload  
      const updates = z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        assigneeId: z.string().optional(),
        status: z.enum(["todo", "in_progress", "done"]).optional(),
      }).parse(req.body);

      // Fetch the existing task to get its real jobId
      let existingTask: any = null;
      const allJobs = await storage.getJobs();
      for (const job of allJobs) {
        const tasks = await storage.getTeamTasks(job.id);
        const found = tasks.find(t => t.id === req.params.id);
        if (found) {
          existingTask = found;
          break;
        }
      }
      
      if (!existingTask) {
        return res.status(404).json({ error: "Task not found" });
      }

      // Verify user is part of the team using the REAL jobId
      const job = await storage.getJob(existingTask.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const task = await storage.updateTeamTask(req.params.id, updates);
      res.json(task);
    } catch (error) {
      console.error("Error updating team task:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/team-tasks/:id", requireAuth, async (req, res) => {
    try {
      // Fetch the task first to get its real jobId
      let existingTask: any = null;
      const allJobs = await storage.getJobs();
      for (const job of allJobs) {
        const tasks = await storage.getTeamTasks(job.id);
        const found = tasks.find(t => t.id === req.params.id);
        if (found) {
          existingTask = found;
          break;
        }
      }
      
      if (!existingTask) {
        return res.status(404).json({ error: "Task not found" });
      }

      // Verify user is part of the team using the REAL jobId
      const job = await storage.getJob(existingTask.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!);

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      await storage.deleteTeamTask(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting team task:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Team Messages routes
  app.get("/api/jobs/:id/team-messages", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team (customer, freelancer, collaborator, or jobFreelancers member)
      const jobFreelancerRecords = await storage.getJobFreelancers(req.params.id);
      const isJobFreelancerMember = jobFreelancerRecords.some(jf => jf.freelancerId === req.session.userId);
      
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!) ||
        isJobFreelancerMember;

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const messages = await storage.getTeamMessages(req.params.id);
      
      // Enrich messages with user info
      const enrichedMessages = await Promise.all(
        messages.map(async (msg) => {
          const sender = await storage.getUser(msg.senderId);
          return {
            ...msg,
            role: sender?.role || null,
            username: sender?.username || null,
            avatar: sender?.avatar || null,
          };
        })
      );
      
      res.json(enrichedMessages);
    } catch (error) {
      console.error("Error fetching team messages:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/jobs/:id/team-messages", requireAuth, async (req, res) => {
    try {
      // Validate with extended schema that includes max length
      const validatedMessage = insertTeamMessageSchema
        .omit({ senderId: true })
        .extend({
          content: z.string().min(1, "Content is required").max(1000, "Content must be 1000 characters or less"),
        })
        .parse({ ...req.body, jobId: req.params.id });
      
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if user is part of the team (including jobFreelancers members)
      const jobFreelancerRecords = await storage.getJobFreelancers(req.params.id);
      const isJobFreelancerMember = jobFreelancerRecords.some(jf => jf.freelancerId === req.session.userId);
      
      const isPartOfTeam = 
        job.customerId === req.session.userId ||
        job.freelancerId === req.session.userId ||
        job.collaborators?.includes(req.session.userId!) ||
        isJobFreelancerMember;

      if (!isPartOfTeam) {
        return res.status(403).json({ error: "You are not part of this job's team" });
      }

      const message = await storage.createTeamMessage({
        jobId: validatedMessage.jobId,
        senderId: req.session.userId!,
        content: validatedMessage.content,
      });

      res.status(201).json(message);
    } catch (error) {
      console.error("Error creating team message:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/team-messages/:id", requireAuth, async (req, res) => {
    try {
      // Fetch the message first to get its details
      let existingMessage: any = null;
      const allJobs = await storage.getJobs();
      for (const job of allJobs) {
        const messages = await storage.getTeamMessages(job.id);
        const found = messages.find(m => m.id === req.params.id);
        if (found) {
          existingMessage = found;
          break;
        }
      }
      
      if (!existingMessage) {
        return res.status(404).json({ error: "Message not found" });
      }

      // Get current user
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Verify user is the author or a moderator
      const isAuthor = existingMessage.senderId === req.session.userId;
      const isModerator = user.role === "moderator" || user.role === "staff";

      if (!isAuthor && !isModerator) {
        return res.status(403).json({ error: "You can only delete your own messages or must be a moderator" });
      }

      await storage.deleteTeamMessage(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting team message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderation routes
  app.get("/api/moderation/pending", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const pendingJobs = await storage.getJobsByStatus("pending");
      res.json(pendingJobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/moderation/all-jobs", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (_req, res) => {
    try {
      const allJobs = await storage.getJobs({});
      res.json(allJobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderation/:id/approve", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const job = await storage.updateJob(req.params.id, { status: "active" });
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Notify customer that their job was approved
      await storage.createNotification({
        userId: job.customerId,
        type: "job_approved",
        title: "Job approved!",
        message: `Your job "${job.title}" has been approved and is now live on the marketplace.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });


      res.json(job);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderation/:id/reject", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Refund charged funds back to wallet since job was rejected
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        const refundAmount = parseFloat(escrow.totalAmount);
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (currentBalance + refundAmount).toFixed(8),
          });
          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: refundAmount.toFixed(8),
            usdAmount: refundAmount.toFixed(2),
            status: "completed",
            transactionHash: `mod-rejection-refund-${job.id}-${Date.now()}`,
          });
        }
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      const updatedJob = await storage.updateJob(req.params.id, { status: "rejected" });

      // Notify customer that their job was rejected
      await storage.createNotification({
        userId: job.customerId,
        type: "job_rejected",
        title: "Job rejected - funds refunded",
        message: `Your job "${job.title}" was not approved. Your funds have been refunded to your wallet.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(updatedJob);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderation/:id/request-changes", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { feedback } = req.body;
      
      if (!feedback || !feedback.trim()) {
        return res.status(400).json({ error: "Feedback is required" });
      }

      const job = await storage.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Refund charged funds back to wallet - customer will re-pay when resubmitting
      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        const refundAmount = parseFloat(escrow.totalAmount);
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (currentBalance + refundAmount).toFixed(8),
          });
          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: refundAmount.toFixed(8),
            usdAmount: refundAmount.toFixed(2),
            status: "completed",
            transactionHash: `mod-changes-refund-${job.id}-${Date.now()}`,
          });
        }
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      // Update job status to changes_requested and store feedback
      const updatedJob = await storage.updateJob(req.params.id, { 
        status: "changes_requested",
        moderatorFeedback: feedback 
      });

      // Notify the customer with the feedback
      if (job.customerId) {
        await storage.createNotification({
          userId: job.customerId,
          type: "job_changes_requested",
          title: "Changes requested - funds refunded",
          message: `Your job "${job.title}" requires changes. Your funds have been refunded. Changes needed:\n\n${feedback}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.json(updatedJob);
    } catch (error) {
      console.error("Error requesting changes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Serve uploaded proof files. The upload endpoint stores the raw data URL
  // in an in-memory map; without this GET route every /uploads/... link fell
  // through to the SPA and opened the dashboard instead of the file.
  app.get("/uploads/*", async (req, res) => {
    try {
      const fileUrl = `/uploads/${(req.params as any)[0]}`;
      const fileData = uploadedFiles.get(fileUrl);
      if (!fileData) {
        return res.status(404).json({ error: "File not found" });
      }
      // fileData is a data URL like data:image/png;base64,....
      // Parse the data URL without regex to avoid escaping pitfalls.
      const sepIdx = fileData.indexOf(";base64,");
      if (sepIdx === -1 || !fileData.startsWith("data:")) {
        return res.redirect(fileData);
      }
      const mimeType = fileData.slice(5, sepIdx);
      const b64Data = fileData.slice(sepIdx + 8);
      const buf = Buffer.from(b64Data, "base64");
      res.set("Content-Type", mimeType);
      res.set("Content-Disposition", "inline");
      res.send(buf);
    } catch (error) {
      console.error("Error serving upload:", error);
      res.status(500).json({ error: "Failed to serve file" });
    }
  });

  // File upload endpoint (stub for proof uploads)
  app.post("/api/uploads", requireAuth, async (req, res) => {
    try {
      const { fileName, fileData } = req.body;
      
      if (!fileName || !fileData) {
        return res.status(400).json({ error: "File name and data required" });
      }

      const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      const fileUrl = `/uploads/${fileId}-${fileName}`;
      
      uploadedFiles.set(fileUrl, fileData);
      
      res.json({ url: fileUrl });
    } catch (error) {
      res.status(500).json({ error: "File upload failed" });
    }
  });

  // Cancellation request routes
  app.post("/api/cancellation-requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { jobId, reason, proofUrl } = req.body;
      
      if (!jobId) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      const job = await storage.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Role-based access control
      const isFreelancer = user.role === "freelancer" && job.freelancerId === user.id;
      const isCustomer = user.role === "customer" && job.customerId === user.id;

      if (!isFreelancer && !isCustomer) {
        return res.status(403).json({ error: "You can only cancel your own jobs" });
      }

      // Determine if approval is required based on role and job status
      let approvalRequired = false;
      let newJobStatus: string = job.status;

      if (isFreelancer) {
        // Freelancer: always requires admin approval if job is taken/in-progress
        if (job.status === "claimed" || job.status === "in_progress") {
          approvalRequired = true;
          if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ error: "Reason must be at least 10 characters" });
          }
        }
      } else if (isCustomer) {
        // Customer: immediate cancellation for active/pending, approval required for taken jobs
        if (job.status === "pending" || job.status === "active") {
          // Immediate cancellation - no approval needed
          approvalRequired = false;
          newJobStatus = "active"; // Reset to active (or could use a "cancelled" status)
        } else if (job.status === "claimed" || job.status === "in_progress") {
          // Requires admin approval
          approvalRequired = true;
        }
      }

      // Create cancellation request record for audit
      const cancellationRequest = await storage.createCancellationRequest({
        jobId,
        requesterId: user.id,
        reason: reason || "No reason provided",
        proofUrl: proofUrl || null,
        status: approvalRequired ? "pending" : "approved",
        reviewerId: approvalRequired ? null : user.id,
        reviewNotes: approvalRequired ? null : "Auto-approved: immediate customer cancellation",
      });

      // If no approval required, update job status immediately and refund
      let updatedJob = job;
      if (!approvalRequired && isCustomer) {
        // Refund escrow funds back to wallet
        const escrow = await storage.getEscrowByJob(jobId);
        if (escrow && escrow.status === EscrowStatus.HELD) {
          const refundAmount = parseFloat(escrow.totalAmount);
          const customerWallet = await storage.getWallet(job.customerId);
          if (customerWallet) {
            const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
            await storage.updateWallet(job.customerId, {
              usdtBalance: (currentBalance + refundAmount).toFixed(8),
            });
            await storage.createTransaction({
              walletId: customerWallet.id,
              type: "refund",
              currency: "USDT",
              amount: refundAmount.toFixed(8),
              usdAmount: refundAmount.toFixed(2),
              status: "completed",
              transactionHash: `cancel-refund-${job.id}-${Date.now()}`,
            });
          }
          await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
        }

        updatedJob = await storage.updateJob(jobId, {
          status: JobStatus.CANCELLED,
          freelancerId: null,
          collaborators: [],
        }) || job;

        const refundTotal = parseFloat(job.budget) + parseFloat(job.premiumAmount || "0");
        await storage.createNotification({
          userId: user.id,
          type: "cancellation_request",
          title: "Job cancelled - funds refunded",
          message: `Your job "${job.title}" has been cancelled. $${refundTotal.toFixed(2)} has been refunded to your wallet.`,
          relatedId: jobId,
          sourceType: "job",
          sourceId: jobId,
        });
      }

      res.json({
        cancellationRequest,
        approvalRequired,
        jobStatus: updatedJob.status,
        message: approvalRequired 
          ? "Cancellation request submitted for admin review" 
          : "Job cancelled successfully",
      });
    } catch (error: any) {
      console.error("Cancellation request error:", error);
      res.status(400).json({ error: error.message || "Invalid cancellation request" });
    }
  });

  app.get("/api/cancellation-requests", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const requests = await storage.getAllCancellationRequests();
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/cancellation-requests/my", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getCancellationRequests({ requesterId: req.session.userId! });
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/cancellation-requests/job/:jobId", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getCancellationRequests({ jobId: req.params.jobId });
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/cancellation-requests/:id/approve", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.getCancellationRequest(req.params.id);
      if (!request) {
        return res.status(404).json({ error: "Cancellation request not found" });
      }

      const job = await storage.getJob(request.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const updatedRequest = await storage.updateCancellationRequest(req.params.id, {
        status: "approved",
        reviewerId: req.session.userId!,
        reviewNotes: req.body.reviewNotes || null,
      });

      // Refund charged funds back to customer wallet
      const jobBudget = parseFloat(job.budget);
      const jobPremium = parseFloat(job.premiumAmount || "0");
      const totalRefund = jobBudget + jobPremium;

      const escrow = await storage.getEscrowByJob(job.id);
      if (escrow && escrow.status === EscrowStatus.HELD) {
        const customerWallet = await storage.getWallet(job.customerId);
        if (customerWallet) {
          const currentBalance = parseFloat(customerWallet.usdtBalance || "0");
          await storage.updateWallet(job.customerId, {
            usdtBalance: (currentBalance + totalRefund).toFixed(8),
          });
          await storage.createTransaction({
            walletId: customerWallet.id,
            type: "refund",
            currency: "USDT",
            amount: totalRefund.toFixed(8),
            usdAmount: totalRefund.toFixed(2),
            status: "completed",
            transactionHash: `cancel-approve-refund-${job.id}-${Date.now()}`,
          });
        }
        await storage.updateEscrow(escrow.id, { status: EscrowStatus.REFUNDED });
      }

      const updatedJob = await storage.updateJob(request.jobId, { 
        status: JobStatus.CANCELLED,
        freelancerId: null,
      });

      // A cancelled job counts against every assigned freelancer's completion rate
      // unless the moderator opted to leave completion rates unaffected.
      const affectCompletionRate = req.body.affectCompletionRate !== false;
      if (affectCompletionRate) {
        await penalizeAllJobFreelancers(job);
      }

      res.json({ request: updatedRequest, job: updatedJob });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/cancellation-requests/:id/decline", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.updateCancellationRequest(req.params.id, {
        status: "declined",
        reviewerId: req.session.userId!,
        reviewNotes: req.body.reviewNotes || null,
      });

      if (!request) {
        return res.status(404).json({ error: "Cancellation request not found" });
      }

      res.json(request);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/cancellation-requests/:id/request-evidence", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.updateCancellationRequest(req.params.id, {
        status: "needs_more_evidence",
        reviewerId: req.session.userId!,
        reviewNotes: req.body.reviewNotes || "Additional evidence required",
      });

      if (!request) {
        return res.status(404).json({ error: "Cancellation request not found" });
      }

      res.json(request);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Wallet routes
  app.get("/api/wallet", requireAuth, async (req, res) => {
    try {
      let wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        wallet = await storage.createWallet({
          userId: req.session.userId!,
          walletAddress: `0x${Math.random().toString(36).substring(2, 15)}`,
        });
      }
      
      // Calculate available balance
      const totalBalance = parseFloat(wallet.usdtBalance || "0");
      const pendingUsdtBalance = parseFloat(wallet.pendingUsdtBalance || "0");
      const availableBalance = totalBalance - pendingUsdtBalance;
      
      // Return wallet with calculated available balance
      res.json({
        ...wallet,
        availableUsdtBalance: availableBalance.toFixed(8),
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/prices", async (req, res) => {
    try {
      // Get real-time prices from polling service
      const priceService = getCryptoPriceService();
      const currentPrices = priceService.getCurrentPrices();
      
      // Return in the format expected by frontend
      const prices = {
        btc: { usd: currentPrices.btc, usd_24h_change: 0 },
        sol: { usd: currentPrices.sol, usd_24h_change: 0 },
        ltc: { usd: currentPrices.ltc, usd_24h_change: 0 },
        usdt: { usd: currentPrices.usdt, usd_24h_change: 0 },
      };
      
      res.json(prices);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch prices" });
    }
  });

  app.get("/api/wallet/transactions", requireAuth, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        return res.json([]);
      }
      const transactions = await storage.getTransactions(wallet.id);
      res.json(transactions);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/wallet/withdraw", requireAuth, async (req, res) => {
    try {
      const { currency, amount, address } = req.body;
      
      const wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Validate wallet address
      if (!address || typeof address !== 'string' || address.trim().length < 10) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const withdrawAmount = parseFloat(amount);
      
      // CRITICAL: Validate amount - prevent negative and zero withdrawals
      if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return res.status(400).json({ error: "Withdrawal amount must be greater than $0" });
      }
      
      // Minimum withdrawal is $0.01
      if (withdrawAmount < 0.01) {
        return res.status(400).json({ error: "Minimum withdrawal is $0.01" });
      }

      // Simulate withdrawal (in production, this would interact with blockchain)
      const currencyKey = `${currency.toLowerCase()}Balance` as keyof typeof wallet;
      const currentBalance = parseFloat(wallet[currencyKey] as string);

      // For USDT, check available balance (total - pending)
      if (currency.toUpperCase() === "USDT") {
        const pendingUsdtBalance = parseFloat(wallet.pendingUsdtBalance || "0");
        const availableBalance = currentBalance - pendingUsdtBalance;
        
        if (availableBalance < withdrawAmount) {
          return res.status(400).json({ 
            error: "Insufficient available balance",
            details: `You have ${availableBalance.toFixed(2)} USDT available (${pendingUsdtBalance.toFixed(2)} USDT locked in active jobs)`
          });
        }
      } else if (currentBalance < withdrawAmount) {
        return res.status(400).json({ error: "Insufficient balance" });
      }

      // Update wallet balance
      await storage.updateWallet(req.session.userId!, {
        [currencyKey]: (currentBalance - withdrawAmount).toString(),
      });

      // Get current price
      const prices = await getCryptoPrices();
      const price = prices[currency.toLowerCase()]?.usd || 0;

      // Create transaction record
      const transaction = await storage.createTransaction({
        walletId: wallet.id,
        type: "withdrawal",
        currency,
        amount: withdrawAmount.toString(),
        usdAmount: (withdrawAmount * price).toString(),
        status: "completed",
        transactionHash: `0x${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`,
      });

      res.json(transaction);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Deposit endpoint
  app.post("/api/wallet/deposit", requireAuth, async (req, res) => {
    try {
      const { currency, amount } = req.body;
      
      const wallet = await storage.getWallet(req.session.userId!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      const depositAmount = parseFloat(amount);
      
      // Validate amount - prevent negative and zero deposits
      if (isNaN(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({ error: "Deposit amount must be greater than $0" });
      }
      
      // Minimum deposit is $1.00
      if (depositAmount < 1.00) {
        return res.status(400).json({ error: "Minimum deposit is $1.00" });
      }

      const currencyKey = `${currency.toLowerCase()}Balance` as keyof typeof wallet;
      const currentBalance = parseFloat(wallet[currencyKey] as string || "0");

      // Update wallet balance
      await storage.updateWallet(req.session.userId!, {
        [currencyKey]: (currentBalance + depositAmount).toString(),
      });

      // Get current price
      const prices = await getCryptoPrices();
      const price = prices[currency.toLowerCase()]?.usd || 1;

      // Create transaction record
      const transaction = await storage.createTransaction({
        walletId: wallet.id,
        type: "deposit",
        currency,
        amount: depositAmount.toString(),
        usdAmount: (depositAmount * price).toString(),
        status: "completed",
        transactionHash: `0x${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`,
      });

      res.json(transaction);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Transfer money (USDT) to another user
  app.post("/api/wallet/transfer", requireAuth, async (req, res) => {
    try {
      const { toUserId, amount } = z.object({
        toUserId: z.string().min(1),
        amount: z.coerce.number().positive(),
      }).parse(req.body);

      if (toUserId === req.session.userId) {
        return res.status(400).json({ error: "You cannot transfer money to yourself" });
      }
      const recipient = await storage.getUser(toUserId);
      if (!recipient) {
        return res.status(404).json({ error: "Recipient not found" });
      }

      const result = await performUsdtTransfer(req.session.userId!, toUserId, amount);
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }

      const sender = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: toUserId,
        type: "money_received",
        title: "You received money",
        message: `${sender?.username || "A user"} sent you $${amount.toFixed(2)}.`,
        relatedId: sender?.id || null,
        sourceType: "user",
        sourceId: sender?.id || null,
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error transferring money:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Request money (USDT) from another user
  app.post("/api/wallet/request", requireAuth, async (req, res) => {
    try {
      const { toUserId, amount, message } = z.object({
        toUserId: z.string().min(1),
        amount: z.coerce.number().positive(),
        message: z.string().max(500).optional(),
      }).parse(req.body);

      if (toUserId === req.session.userId) {
        return res.status(400).json({ error: "You cannot request money from yourself" });
      }
      const recipient = await storage.getUser(toUserId);
      if (!recipient) {
        return res.status(404).json({ error: "User not found" });
      }

      const request = await storage.createMoneyRequest({
        requesterId: req.session.userId!,
        recipientId: toUserId,
        amount: amount.toFixed(2),
        message: message || null,
      });

      const requester = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: toUserId,
        type: "money_request",
        title: "Money request",
        message: `${requester?.username || "A user"} requested $${amount.toFixed(2)} from you.`,
        relatedId: request.id,
        sourceType: "user",
        sourceId: requester?.id || null,
      });

      res.status(201).json(request);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error requesting money:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // List money requests involving the current user
  app.get("/api/wallet/requests", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const requests = await storage.getMoneyRequestsForUser(userId);
      const enriched = await Promise.all(
        requests.map(async (r) => {
          const counterpartId = r.requesterId === userId ? r.recipientId : r.requesterId;
          const counterpart = await storage.getUser(counterpartId);
          return {
            ...r,
            direction: r.requesterId === userId ? "outgoing" : "incoming",
            counterpartUsername: counterpart?.username || "Unknown",
            counterpartAvatar: counterpart?.avatar || null,
          };
        })
      );
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching money requests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Recipient pays (accepts) a money request
  app.post("/api/wallet/requests/:id/accept", requireAuth, async (req, res) => {
    try {
      const request = await storage.getMoneyRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.recipientId !== req.session.userId) {
        return res.status(403).json({ error: "Only the recipient can accept this request" });
      }
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request is no longer pending" });
      }

      const amount = parseFloat(request.amount);
      const result = await performUsdtTransfer(req.session.userId!, request.requesterId, amount);
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }

      await storage.updateMoneyRequest(request.id, { status: "accepted" });

      const payer = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: request.requesterId,
        type: "money_received",
        title: "Money request paid",
        message: `${payer?.username || "A user"} paid your request and sent you $${amount.toFixed(2)}.`,
        relatedId: request.id,
        sourceType: "user",
        sourceId: payer?.id || null,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error accepting money request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Recipient declines a money request
  app.post("/api/wallet/requests/:id/decline", requireAuth, async (req, res) => {
    try {
      const request = await storage.getMoneyRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.recipientId !== req.session.userId) {
        return res.status(403).json({ error: "Only the recipient can decline this request" });
      }
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request is no longer pending" });
      }
      await storage.updateMoneyRequest(request.id, { status: "declined" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error declining money request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Requester cancels their own outgoing request
  app.post("/api/wallet/requests/:id/cancel", requireAuth, async (req, res) => {
    try {
      const request = await storage.getMoneyRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.requesterId !== req.session.userId) {
        return res.status(403).json({ error: "Only the requester can cancel this request" });
      }
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request is no longer pending" });
      }
      await storage.updateMoneyRequest(request.id, { status: "cancelled" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling money request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderation Vault routes
  app.get("/api/vault", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const vault = await storage.getModerationVault();
      res.json(vault);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Platform fees the company has actually earned (used to cap vault deposits).
  async function computePlatformFees(): Promise<number> {
    const jobs = await storage.getJobs({});
    let total = 0;
    for (const job of jobs) {
      if (job.status !== JobStatus.COMPLETED) continue;
      const budget = parseFloat(job.budget || "0");
      const premium = parseFloat((job as any).premiumAmount || "0");
      const jfRecords = await storage.getJobFreelancers(job.id);
      let paidOut = 0;
      if (jfRecords.length > 0) {
        for (const jf of jfRecords) {
          if (jf.payoutAmount) paidOut += parseFloat(jf.payoutAmount);
        }
      } else if (job.freelancerId) {
        const fl = await storage.getUser(job.freelancerId);
        const level = fl?.level || 1;
        paidOut = budget * getLevelPayout(level);
      }
      total += Math.max(0, budget + premium - paidOut);
    }
    return total;
  }

  function dayKey(dt: Date): string {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return y + '-' + m + '-' + d;
  }

  // Company Vault - founder-only view of all money in the platform
  app.get("/api/company-vault", requireRole("founder"), async (_req, res) => {
    try {
      const users = await storage.getUsers();
      const jobs = await storage.getJobs({});
      const vault = await storage.getModerationVault();
      const disputes = await storage.getDisputes();

      // Last 14 days of marketplace activity for the comparison column chart
      const seriesMap = new Map<string, { date: string; label: string; profit: number; completed: number; cancelled: number; disputes: number; active: number }>();
      for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const key = dayKey(d);
        seriesMap.set(key, {
          date: key,
          label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          profit: 0, completed: 0, cancelled: 0, disputes: 0, active: 0,
        });
      }

      let customerHeld = 0;
      let freelancerHeld = 0;
      let otherHeld = 0;
      let freelancerCount = 0;
      let customerCount = 0;
      let moderatorCount = 0;

      for (const u of users) {
        const wallet = await storage.getWallet(u.id);
        const balance = wallet ? parseFloat(wallet.usdtBalance || "0") : 0;
        if (u.role === "customer") { customerHeld += balance; customerCount++; }
        else if (u.role === "freelancer") { freelancerHeld += balance; freelancerCount++; }
        else { otherHeld += balance; if (u.role === "moderator" || u.role === "head_of_moderation") moderatorCount++; }
      }

      let pendingEscrow = 0;
      let pendingEscrowCount = 0;
      let companyHeld = 0;
      let completedJobs = 0;
      let activeJobs = 0;
      let cancelledJobs = 0;
      let disputedJobs = 0;

      for (const job of jobs) {
        const budget = parseFloat(job.budget || "0");
        const premium = parseFloat((job as any).premiumAmount || "0");
        const escrow = await storage.getEscrowByJob(job.id);

        if (escrow && escrow.status === EscrowStatus.HELD) {
          pendingEscrow += parseFloat(escrow.totalAmount || "0");
          pendingEscrowCount++;
        }

        if (job.status === JobStatus.COMPLETED) {
          completedJobs++;
          // Platform keeps budget + premium minus what freelancers were paid.
          const jfRecords = await storage.getJobFreelancers(job.id);
          let paidOut = 0;
          if (jfRecords.length > 0) {
            for (const jf of jfRecords) {
              if (jf.payoutAmount) paidOut += parseFloat(jf.payoutAmount);
            }
          } else if (job.freelancerId) {
            const fl = await storage.getUser(job.freelancerId);
            const level = fl?.level || 1;
            paidOut = budget * getLevelPayout(level);
          }
          const fee = Math.max(0, budget + premium - paidOut);
          companyHeld += fee;
          const cKey = dayKey(job.updatedAt || job.createdAt || new Date());
          const cBucket = seriesMap.get(cKey);
          if (cBucket) { cBucket.profit += fee; cBucket.completed += 1; }
        } else if (job.status === JobStatus.ACTIVE || job.status === JobStatus.CLAIMED || job.status === JobStatus.IN_PROGRESS || job.status === JobStatus.SUBMITTED || job.status === JobStatus.AWAITING_CUSTOMER) {
          activeJobs++;
        } else if (job.status === JobStatus.CANCELLED) {
          cancelledJobs++;
          const cKey = dayKey(job.updatedAt || job.createdAt || new Date());
          const cBucket = seriesMap.get(cKey);
          if (cBucket) cBucket.cancelled += 1;
        } else if (job.status === JobStatus.DISPUTE) {
          disputedJobs++;
        }
      }

      // Disputes opened per day
      for (const d of disputes) {
        const dKey = dayKey(d.createdAt || new Date());
        const dBucket = seriesMap.get(dKey);
        if (dBucket) dBucket.disputes += 1;
      }
      // Active jobs per day (jobs whose life window covers that day)
      const nowTs = Date.now();
      for (const job of jobs) {
        const start = (job.createdAt || new Date()).getTime();
        const end = (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED)
          ? (job.updatedAt || new Date()).getTime()
          : nowTs;
        for (const bucket of Array.from(seriesMap.values())) {
          const dayStart = new Date(bucket.date + "T00:00:00").getTime();
          if (start < dayStart + 86400000 && end > dayStart) bucket.active += 1;
        }
      }
      const series = Array.from(seriesMap.values()).map(b => ({
        ...b,
        profit: Math.round(b.profit * 100) / 100,
      }));

      const transferredFromCompany = parseFloat(vault.transferredFromCompany || "0");
      const companyHeldRounded = Math.round((companyHeld - transferredFromCompany) * 100) / 100;
      const moderationVault = parseFloat(vault.balance || "0");
      const totalInPlatform = Math.round((customerHeld + freelancerHeld + pendingEscrow + companyHeldRounded + moderationVault) * 100) / 100;

      res.json({
        customerHeld: Math.round(customerHeld * 100) / 100,
        freelancerHeld: Math.round(freelancerHeld * 100) / 100,
        pendingEscrow: Math.round(pendingEscrow * 100) / 100,
        pendingEscrowCount,
        companyHeld: companyHeldRounded,
        moderationVault: Math.round(moderationVault * 100) / 100,
        totalInPlatform,
        counts: {
          users: users.length,
          freelancers: freelancerCount,
          customers: customerCount,
          moderators: moderatorCount,
          jobs: jobs.length,
          activeJobs,
          completedJobs,
          cancelledJobs,
          disputedJobs,
        },
        feeStructure: {
          level1: "40% platform fee",
          level2: "30% platform fee",
          level3: "20% platform fee",
          level4: "15% platform fee",
          level5: "10% platform fee",
        },
        series,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Company vault error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/vault/transactions", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const transactions = await storage.getVaultTransactions();
      
      // Enrich with user info
      const enrichedTransactions = await Promise.all(transactions.map(async (t) => {
        let fromUser = null;
        let toUser = null;
        let distributedBy = null;
        
        if (t.fromUserId) {
          const user = await storage.getUser(t.fromUserId);
          fromUser = user ? { id: user.id, username: user.username } : null;
        }
        if (t.toUserId) {
          const user = await storage.getUser(t.toUserId);
          toUser = user ? { id: user.id, username: user.username } : null;
        }
        if (t.distributedByUserId) {
          const user = await storage.getUser(t.distributedByUserId);
          distributedBy = user ? { id: user.id, username: user.username } : null;
        }
        
        return {
          ...t,
          fromUser,
          toUser,
          distributedBy,
        };
      }));
      
      res.json(enrichedTransactions);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/vault/deposit", requireRole("founder"), async (req, res) => {
    try {
      const { amount, note } = req.body;
      const depositAmount = parseFloat(amount);
      
      if (isNaN(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({ error: "Deposit amount must be greater than $0" });
      }
      
      if (depositAmount < 1.00) {
        return res.status(400).json({ error: "Minimum deposit is $1.00" });
      }

      // Founder deposits can only move money the company actually holds
      // (platform fees earned from completed jobs, minus what has already
      // been transferred into the moderation vault).
      const vault = await storage.getModerationVault();
      const platformFees = await computePlatformFees();
      const alreadyTransferred = parseFloat(vault.transferredFromCompany || "0");
      const companyAvailable = Math.max(0, platformFees - alreadyTransferred);
      if (depositAmount > companyAvailable) {
        return res.status(400).json({
          error: "Cannot deposit more than the company holds ($" + companyAvailable.toFixed(2) + " available)."
        });
      }

      const transaction = await storage.depositToVault(depositAmount, req.session.userId!, note);
      
      // Notify Head of Moderation about the deposit
      const users = await storage.getUsers();
      const homUsers = users.filter(u => u.role === "head_of_moderation");
      for (const hom of homUsers) {
        await storage.createNotification({
          userId: hom.id,
          type: "vault_deposit",
          title: "Vault Deposit",
          message: `The Founder deposited $${depositAmount.toFixed(2)} to the moderation vault.`,
          relatedId: transaction.id,
          sourceType: "system",
          sourceId: transaction.id,
        });
      }
      
      res.json(transaction);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/vault/distribute", requireRole("head_of_moderation"), async (req, res) => {
    try {
      const { amount, toUserId, note } = req.body;
      const distributeAmount = parseFloat(amount);
      
      if (isNaN(distributeAmount) || distributeAmount <= 0) {
        return res.status(400).json({ error: "Distribution amount must be greater than $0" });
      }

      if (!toUserId) {
        return res.status(400).json({ error: "Recipient user ID is required" });
      }

      // Verify recipient is a moderator or staff
      const recipient = await storage.getUser(toUserId);
      if (!recipient) {
        return res.status(404).json({ error: "Recipient not found" });
      }
      
      if (!["moderator", "staff"].includes(recipient.role)) {
        return res.status(400).json({ error: "Can only distribute funds to moderators or staff" });
      }

      // Check vault balance
      const vault = await storage.getModerationVault();
      const vaultBalance = parseFloat(vault.balance || "0");
      if (vaultBalance < distributeAmount) {
        return res.status(400).json({ error: "Insufficient vault balance" });
      }

      // Perform distribution
      const transaction = await storage.distributeFromVault(
        distributeAmount,
        toUserId,
        req.session.userId!,
        note
      );

      // Add funds to recipient's wallet
      let recipientWallet = await storage.getWallet(toUserId);
      if (!recipientWallet) {
        recipientWallet = await storage.createWallet({
          userId: toUserId,
          walletAddress: `0x${Math.random().toString(36).substring(2, 15)}`,
        });
      }
      const currentBalance = parseFloat(recipientWallet.usdtBalance || "0");
      await storage.updateWallet(toUserId, {
        usdtBalance: (currentBalance + distributeAmount).toString(),
      });

      // Notify the recipient
      await storage.createNotification({
        userId: toUserId,
        type: "vault_distribution",
        title: "Funds Received",
        message: `You received $${distributeAmount.toFixed(2)} from the moderation vault${note ? `: ${note}` : ""}.`,
        relatedId: transaction.id,
        sourceType: "system",
        sourceId: transaction.id,
      });
      
      res.json(transaction);
    } catch (error) {
      console.error("Vault distribution error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all moderators/staff for vault recipient list and Manage Funds
  app.get("/api/team/moderators", requireRole("head_of_moderation", "founder"), async (_req, res) => {
    try {
      const allUsers = await storage.getUsers();
      const modTeam = allUsers.filter(u => u.role === "moderator" || u.role === "staff");
      res.json(modTeam);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all weekly incomes
  app.get("/api/moderation/weekly-income", requireRole("head_of_moderation", "founder"), async (_req, res) => {
    try {
      const incomes = await storage.getAllModeratorWeeklyIncomes();
      res.json(incomes);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Set weekly income for a moderator
  app.put("/api/moderation/weekly-income/:moderatorId", requireRole("head_of_moderation"), async (req, res) => {
    try {
      const { weeklyAmount } = req.body;
      const amount = parseFloat(weeklyAmount);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: "Invalid weekly amount" });
      }
      const moderator = await storage.getUser(req.params.moderatorId);
      if (!moderator || !["moderator", "staff"].includes(moderator.role)) {
        return res.status(404).json({ error: "Moderator not found" });
      }
      await storage.setModeratorWeeklyIncome(req.params.moderatorId, amount, req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Calendar Event routes - accessible to moderation team
  const calendarRoles = ["moderator", "head_of_moderation", "founder"] as const;

  app.get("/api/calendar/events", requireRole(...calendarRoles), async (_req, res) => {
    try {
      const events = await storage.getCalendarEvents();
      res.json(events);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/calendar/events", requireRole(...calendarRoles), async (req, res) => {
    try {
      const { title, description, startTime, endTime } = req.body;
      if (!title || !startTime || !endTime) {
        return res.status(400).json({ error: "title, startTime, and endTime are required" });
      }
      const start = new Date(startTime);
      const end = new Date(endTime);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      if (end <= start) {
        return res.status(400).json({ error: "End time must be after start time" });
      }
      const event = await storage.createCalendarEvent({
        title: title.trim(),
        description: (description || "").trim(),
        startTime: start,
        endTime: end,
        createdBy: req.session.userId!,
        type: "event",
      });
      res.json(event);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/calendar/events/:id", requireRole(...calendarRoles), async (req, res) => {
    try {
      const events = await storage.getCalendarEvents();
      const event = events.find(e => e.id === req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });
      const user = await storage.getUser(req.session.userId!);
      const isCreator = event.createdBy === req.session.userId;
      const isLeader = user && ["head_of_moderation", "founder"].includes(user.role);
      if (!isCreator && !isLeader) {
        return res.status(403).json({ error: "You can only edit your own events" });
      }
      const { title, description, startTime, endTime } = req.body;
      const updates: Partial<CalendarEvent> = {};
      if (title !== undefined) {
        if (typeof title !== "string" || !title.trim()) {
          return res.status(400).json({ error: "Title cannot be empty" });
        }
        updates.title = title.trim();
      }
      if (description !== undefined) updates.description = String(description).trim();
      if (startTime !== undefined) {
        const start = new Date(startTime);
        if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start date" });
        updates.startTime = start;
      }
      if (endTime !== undefined) {
        const end = new Date(endTime);
        if (isNaN(end.getTime())) return res.status(400).json({ error: "Invalid end date" });
        updates.endTime = end;
      }
      if (updates.startTime && updates.endTime && updates.endTime <= updates.startTime) {
        return res.status(400).json({ error: "End time must be after start time" });
      }
      const updated = await storage.updateCalendarEvent(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: "Event not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/calendar/events/:id", requireRole(...calendarRoles), async (req, res) => {
    try {
      const events = await storage.getCalendarEvents();
      const event = events.find(e => e.id === req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });
      const user = await storage.getUser(req.session.userId!);
      const isCreator = event.createdBy === req.session.userId;
      const isLeader = user && ["head_of_moderation", "founder"].includes(user.role);
      if (!isCreator && !isLeader) {
        return res.status(403).json({ error: "You can only delete your own events" });
      }
      await storage.deleteCalendarEvent(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Friend routes
  app.get("/api/friends", requireAuth, async (req, res) => {
    try {
      const friendships = await storage.getFriends(req.session.userId!);
      
      // Enrich with user info
      const friends = await Promise.all(friendships.map(async (f) => {
        const friendId = f.userId === req.session.userId ? f.friendId : f.userId;
        const user = await storage.getUser(friendId);
        return user ? {
          id: f.id,
          friendId: user.id,
          userId: user.userId,
          username: user.username,
          avatar: user.avatar,
          role: user.role,
          createdAt: f.createdAt,
        } : null;
      }));
      
      res.json(friends.filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/friend-requests", requireAuth, async (req, res) => {
    try {
      const incoming = await storage.getIncomingFriendRequests(req.session.userId!);
      
      // Enrich with user info
      const enrichedRequests = await Promise.all(incoming.map(async (r) => {
        const fromUser = await storage.getUser(r.fromUserId);
        return {
          ...r,
          fromUser: fromUser ? {
            id: fromUser.id,
            userId: fromUser.userId,
            username: fromUser.username,
            avatar: fromUser.avatar,
            role: fromUser.role,
          } : null,
        };
      }));
      
      res.json(enrichedRequests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/friend-requests/outgoing", requireAuth, async (req, res) => {
    try {
      const allRequests = await storage.getFriendRequestsByUser(req.session.userId!);
      const outgoing = allRequests.filter(r => r.fromUserId === req.session.userId && r.status === "pending");
      
      // Enrich with user info
      const enrichedRequests = await Promise.all(outgoing.map(async (r) => {
        const toUser = await storage.getUser(r.toUserId);
        return {
          ...r,
          toUser: toUser ? {
            id: toUser.id,
            userId: toUser.userId,
            username: toUser.username,
            avatar: toUser.avatar,
            role: toUser.role,
          } : null,
        };
      }));
      
      res.json(enrichedRequests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/friend-requests", requireAuth, async (req, res) => {
    try {
      const { toUserId } = req.body;
      
      if (!toUserId) {
        return res.status(400).json({ error: "Target user ID is required" });
      }
      
      // Can't send friend request to yourself
      if (toUserId === req.session.userId) {
        return res.status(400).json({ error: "Cannot send friend request to yourself" });
      }
      
      // Check if target user exists
      const targetUser = await storage.getUser(toUserId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Check if already friends
      const alreadyFriends = await storage.areFriends(req.session.userId!, toUserId);
      if (alreadyFriends) {
        return res.status(400).json({ error: "Already friends with this user" });
      }
      
      // Check if there's already a pending request between these users
      const existingRequest = await storage.getFriendRequestBetweenUsers(req.session.userId!, toUserId);
      if (existingRequest && existingRequest.status === "pending") {
        return res.status(400).json({ error: "A friend request already exists between you and this user. Please wait for them to respond." });
      }

      // Anti-spam: if the recipient declined/cancelled a previous request, or
      // these two users were recently friends, block re-sending for 10 minutes
      // so a user can't spam repeated requests (e.g. add/unfriend/re-add).
      // After the cooldown a single new request is allowed.
      if (existingRequest && (existingRequest.status === "declined" || existingRequest.status === "accepted")) {
        const lastActionAt = existingRequest.updatedAt ? new Date(existingRequest.updatedAt).getTime() : 0;
        const cooldownMs = 10 * 60 * 1000;
        if (Date.now() - lastActionAt < cooldownMs) {
          const minutesLeft = Math.max(1, Math.ceil((cooldownMs - (Date.now() - lastActionAt)) / 60000));
          if (existingRequest.status === "declined") {
            return res.status(429).json({
              error: existingRequest.fromUserId === req.session.userId
                ? `They declined your recent friend request. You can send another in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`
                : `You declined their recent friend request. They can send another in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`
            });
          }
          return res.status(429).json({
            error: `You recently unfriended each other. You can send another friend request in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`
          });
        }
        // Cooldown over — reuse the record so there is never more than one
        // request per pair of users.
        const refreshed = await storage.updateFriendRequest(existingRequest.id, {
          fromUserId: req.session.userId,
          toUserId,
          status: "pending",
          createdAt: new Date(),
        });
        const sender = await storage.getUser(req.session.userId!);
        await storage.createNotification({
          userId: toUserId,
          type: "friend_request",
          title: "Friend Request",
          message: `${sender?.username || "Someone"} sent you a friend request.`,
          relatedId: refreshed!.id,
          sourceType: "user",
          sourceId: req.session.userId!,
        });
        return res.json(refreshed);
      }
      
      const request = await storage.createFriendRequest({
        fromUserId: req.session.userId!,
        toUserId,
        status: "pending",
      });
      
      // Notify the target user
      const sender = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: toUserId,
        type: "friend_request",
        title: "Friend Request",
        message: `${sender?.username || "Someone"} sent you a friend request.`,
        relatedId: request.id,
        sourceType: "user",
        sourceId: req.session.userId!,
      });
      
      res.json(request);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/friend-requests/:id/accept", requireAuth, async (req, res) => {
    try {
      const request = await storage.getFriendRequest(req.params.id);
      
      if (!request) {
        return res.status(404).json({ error: "Friend request not found" });
      }
      
      if (request.toUserId !== req.session.userId) {
        return res.status(403).json({ error: "Can only accept requests sent to you" });
      }
      
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request has already been processed" });
      }
      
      // Update request status
      await storage.updateFriendRequest(request.id, { status: "accepted" });
      
      // Create the friendship
      await storage.createFriendship(request.fromUserId, request.toUserId);
      
      // Notify the sender
      const accepter = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: request.fromUserId,
        type: "friend_accepted",
        title: "Friend Request Accepted",
        message: `${accepter?.username || "Someone"} accepted your friend request.`,
        relatedId: request.id,
        sourceType: "user",
        sourceId: req.session.userId!,
      });
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/friend-requests/:id/decline", requireAuth, async (req, res) => {
    try {
      const request = await storage.getFriendRequest(req.params.id);
      
      if (!request) {
        return res.status(404).json({ error: "Friend request not found" });
      }
      
      if (request.toUserId !== req.session.userId) {
        return res.status(403).json({ error: "Can only decline requests sent to you" });
      }
      
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request has already been processed" });
      }
      
      await storage.updateFriendRequest(request.id, { status: "declined" });
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/friend-requests/:id/cancel", requireAuth, async (req, res) => {
    try {
      const request = await storage.getFriendRequest(req.params.id);
      
      if (!request) {
        return res.status(404).json({ error: "Friend request not found" });
      }
      
      if (request.fromUserId !== req.session.userId) {
        return res.status(403).json({ error: "Can only cancel requests you sent" });
      }
      
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request has already been processed" });
      }
      
      await storage.updateFriendRequest(request.id, { status: "declined" });
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/friends/:friendId", requireAuth, async (req, res) => {
    try {
      const areFriends = await storage.areFriends(req.session.userId!, req.params.friendId);
      
      if (!areFriends) {
        return res.status(400).json({ error: "Not friends with this user" });
      }
      
      await storage.removeFriendship(req.session.userId!, req.params.friendId);
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ FOLLOW ROUTES ============

  app.post("/api/users/:id/follow", requireAuth, async (req, res) => {
    try {
      const followerId = req.session.userId!;
      const followingId = req.params.id;
      if (followerId === followingId) return res.status(400).json({ error: "Cannot follow yourself" });
      const target = await storage.getUser(followingId);
      if (!target) return res.status(404).json({ error: "User not found" });
      const follow = await storage.followUser(followerId, followingId);
      res.json(follow);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/users/:id/follow", requireAuth, async (req, res) => {
    try {
      const followerId = req.session.userId!;
      const followingId = req.params.id;
      await storage.unfollowUser(followerId, followingId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/followers", requireAuth, async (req, res) => {
    try {
      const followers = await storage.getFollowers(req.params.id);
      const enriched = await Promise.all(
        followers.map(async (f) => {
          const user = await storage.getUser(f.followerId);
          return user ? { id: user.id, username: user.username, avatar: user.avatar, followedAt: f.createdAt } : null;
        })
      );
      res.json(enriched.filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/following", requireAuth, async (req, res) => {
    try {
      const following = await storage.getFollowing(req.params.id);
      const enriched = await Promise.all(
        following.map(async (f) => {
          const user = await storage.getUser(f.followingId);
          return user ? { id: user.id, username: user.username, avatar: user.avatar, followedAt: f.createdAt } : null;
        })
      );
      res.json(enriched.filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ BLOCK ROUTES ============

  app.post("/api/users/:id/block", requireAuth, async (req, res) => {
    try {
      const blockerId = req.session.userId!;
      const blockedId = req.params.id;
      if (blockerId === blockedId) return res.status(400).json({ error: "Cannot block yourself" });
      const target = await storage.getUser(blockedId);
      if (!target) return res.status(404).json({ error: "User not found" });
      const block = await storage.blockUser(blockerId, blockedId);
      // Also unfollow each other when blocking
      await storage.unfollowUser(blockerId, blockedId);
      await storage.unfollowUser(blockedId, blockerId);
      res.json(block);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/users/:id/block", requireAuth, async (req, res) => {
    try {
      const blockerId = req.session.userId!;
      const blockedId = req.params.id;
      await storage.unblockUser(blockerId, blockedId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/blocked", requireAuth, async (req, res) => {
    try {
      const blocked = await storage.getBlockedUsers(req.session.userId!);
      const enriched = await Promise.all(
        blocked.map(async (b) => {
          const user = await storage.getUser(b.blockedId);
          return user ? { id: user.id, username: user.username, avatar: user.avatar, blockedAt: b.createdAt } : null;
        })
      );
      res.json(enriched.filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/search", requireAuth, async (req, res) => {
    try {
      const { userId } = req.query;
      
      if (!userId) {
        return res.status(400).json({ error: "User ID query is required" });
      }
      
      const userIdNum = parseInt(userId as string);
      if (isNaN(userIdNum)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }
      
      const users = await storage.searchUsersByUserId(userIdNum);
      
      // Return safe user info
      const results = users.map(u => ({
        id: u.id,
        userId: u.userId,
        username: u.username,
        avatar: u.avatar,
        role: u.role,
        level: u.level,
        completedJobs: u.completedJobs,
        rating: u.rating,
      }));
      
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/:id/friend-status", requireAuth, async (req, res) => {
    try {
      const targetUserId = req.params.id;
      
      if (targetUserId === req.session.userId) {
        return res.json({ status: "self" });
      }
      
      const areFriends = await storage.areFriends(req.session.userId!, targetUserId);
      if (areFriends) {
        return res.json({ status: "friends" });
      }
      
      const existingRequest = await storage.getFriendRequestBetweenUsers(req.session.userId!, targetUserId);
      if (existingRequest && existingRequest.status === "pending") {
        if (existingRequest.fromUserId === req.session.userId) {
          return res.json({ status: "pending_outgoing", requestId: existingRequest.id });
        } else {
          return res.json({ status: "pending_incoming", requestId: existingRequest.id });
        }
      }
      
      res.json({ status: "none" });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Profile routes
  app.get("/api/profile/completed-jobs", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getJobs({ 
        freelancerId: req.session.userId!, 
        status: "completed" 
      });
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Rating routes
  app.post("/api/jobs/:jobId/rating", requireRole("customer"), async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await storage.getJob(jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      
      // Verify customer owns the job
      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can rate this job" });
      }
      
      // Verify job is completed
      if (job.status !== "completed") {
        return res.status(400).json({ error: "Can only rate completed jobs" });
      }
      
      // Determine which freelancer is being rated (default to the lead for backward compat)
      const targetFreelancerId = req.body.freelancerId || job.freelancerId;
      if (!targetFreelancerId) {
        return res.status(400).json({ error: "No freelancer to rate for this job" });
      }

      // The rated freelancer must actually be part of this job (lead, collaborator, or team member)
      const jobFreelancerIds = await getJobFreelancerIds(job);
      if (!jobFreelancerIds.includes(targetFreelancerId)) {
        return res.status(403).json({ error: "That freelancer is not assigned to this job" });
      }
      
      // One rating per freelancer per job
      const existingRating = await storage.getRatingForFreelancer(jobId, targetFreelancerId);
      if (existingRating) {
        return res.status(400).json({ error: "You have already rated this freelancer for this job" });
      }
      
      // Validate rating data
      const validatedData = insertRatingSchema.parse({
        jobId,
        customerId: req.session.userId!,
        freelancerId: targetFreelancerId,
        score: req.body.score,
        review: req.body.review,
      });
      
      // Create rating
      const rating = await storage.createRating(validatedData);
      
      // Update the rated freelancer's average rating and total ratings
      const freelancer = await storage.getUser(targetFreelancerId);
      if (freelancer) {
        const currentRating = parseFloat(freelancer.rating || "0");
        const currentTotal = freelancer.totalRatings || 0;
        const newAverage = ((currentRating * currentTotal) + rating.score) / (currentTotal + 1);
        
        await storage.updateUser(targetFreelancerId, {
          rating: newAverage.toFixed(2),
          totalRatings: currentTotal + 1,
        });
      }
      
      res.json(rating);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  app.get("/api/jobs/:jobId/rating", requireAuth, async (req, res) => {
    try {
      const rating = await storage.getRating(req.params.jobId);
      if (!rating) {
        return res.status(404).json({ error: "Rating not found" });
      }
      res.json(rating);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // All customer ratings for a job (one per rated freelancer)
  app.get("/api/jobs/:jobId/ratings", requireAuth, async (req, res) => {
    try {
      const ratings = await storage.getRatingsByJob(req.params.jobId);
      res.json(ratings);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  app.get("/api/freelancers/:freelancerId/ratings", requireAuth, async (req, res) => {
    try {
      const ratings = await storage.getRatingsByFreelancer(req.params.freelancerId);
      res.json(ratings);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Freelancer rates the customer after a completed job
  app.post("/api/jobs/:jobId/customer-rating", requireRole("freelancer"), async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await storage.getJob(jobId);

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Verify the freelancer worked on this job
      const userId = req.session.userId!;
      if (job.freelancerId !== userId && !(job.collaborators || []).includes(userId)) {
        return res.status(403).json({ error: "Only assigned freelancers can rate this job" });
      }

      if (job.status !== "completed") {
        return res.status(400).json({ error: "Can only rate completed jobs" });
      }

      if (!job.customerId) {
        return res.status(400).json({ error: "No customer to rate for this job" });
      }

      const existingRating = await storage.getCustomerRating(jobId);
      if (existingRating) {
        return res.status(400).json({ error: "Customer rating already submitted for this job" });
      }

      const validatedData = insertCustomerRatingSchema.parse({
        jobId,
        freelancerId: userId,
        customerId: job.customerId,
        score: req.body.score,
        review: req.body.review,
      });

      const rating = await storage.createCustomerRating(validatedData);
      res.json(rating);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/jobs/:jobId/customer-rating", requireAuth, async (req, res) => {
    try {
      const rating = await storage.getCustomerRating(req.params.jobId);
      if (!rating) {
        return res.status(404).json({ error: "Rating not found" });
      }
      res.json(rating);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/customers/:customerId/ratings", requireAuth, async (req, res) => {
    try {
      const ratings = await storage.getCustomerRatings(req.params.customerId);
      res.json(ratings);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PTO routes
  app.get("/api/pto", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getPTORequests(req.session.userId!);
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all pending PTO requests for head of moderation and founder only
  app.get("/api/pto/pending", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const allRequests = await storage.getAllPTORequests();
      const pendingRequests = allRequests.filter(r => r.status === "pending");
      
      // Enrich with freelancer info
      const enrichedRequests = await Promise.all(pendingRequests.map(async (request) => {
        const freelancer = await storage.getUser(request.freelancerId);
        return {
          ...request,
          freelancerUsername: freelancer?.username || "Unknown",
          freelancerAvatar: freelancer?.avatar || null,
        };
      }));
      
      res.json(enrichedRequests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Approve PTO request - head of moderation and founder only
  app.post("/api/pto/:id/approve", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.updatePTORequest(req.params.id, { status: "approved" });
      if (!request) {
        return res.status(404).json({ error: "PTO request not found" });
      }
      
      // Notify freelancer
      await storage.createNotification({
        userId: request.freelancerId,
        type: "pto_approved",
        title: "PTO Request Approved",
        message: `Your PTO request from ${request.startDate} to ${request.endDate} has been approved.`,
        relatedId: request.id,
        sourceType: "system",
        sourceId: request.id,
      });

      // Auto-add PTO to shared calendar
      const requester = await storage.getUser(request.freelancerId);
      const ptoTitle = `PTO: ${requester?.username || "Team Member"}`;
      const ptoStart = new Date(request.startDate);
      ptoStart.setHours(0, 0, 0, 0);
      const ptoEnd = new Date(request.endDate);
      ptoEnd.setHours(23, 59, 59, 999);
      await storage.createCalendarEvent({
        title: ptoTitle,
        description: request.reason || "Approved PTO",
        startTime: ptoStart,
        endTime: ptoEnd,
        createdBy: req.session.userId!,
        type: "pto",
        ptoRequestId: request.id,
      });

      res.json(request);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reject PTO request - head of moderation and founder only
  app.post("/api/pto/:id/reject", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.updatePTORequest(req.params.id, { status: "rejected" });
      if (!request) {
        return res.status(404).json({ error: "PTO request not found" });
      }
      
      // Notify freelancer
      await storage.createNotification({
        userId: request.freelancerId,
        type: "pto_rejected",
        title: "PTO Request Rejected",
        message: `Your PTO request from ${request.startDate} to ${request.endDate} has been rejected.`,
        relatedId: request.id,
        sourceType: "system",
        sourceId: request.id,
      });
      
      res.json(request);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/pto", requireRole("moderator", "staff", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const validated = insertPTORequestSchema.parse(req.body);
      const user = await storage.getUser(req.session.userId!);
      
      // Validate PTO constraints
      const startDate = new Date(validated.startDate);
      const endDate = new Date(validated.endDate);
      
      // End date must be on or after start date (allow same-day PTO)
      if (endDate < startDate) {
        return res.status(400).json({ error: "End date must be on or after start date" });
      }
      
      // PTO duration cannot exceed 21 days (3 weeks) - inclusive count
      const diffDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (diffDays > 21) {
        return res.status(400).json({ error: "PTO duration cannot exceed 3 weeks (21 days)" });
      }
      
      // Start date cannot be more than 3 years in the future
      const maxDate = new Date();
      maxDate.setFullYear(maxDate.getFullYear() + 3);
      if (startDate > maxDate) {
        return res.status(400).json({ error: "Start date cannot be more than 3 years in the future" });
      }
      
      const request = await storage.createPTORequest({
        ...validated,
        freelancerId: req.session.userId!,
      });

      // Notify head of moderation and founder only
      const allUsers = await storage.getUsers();
      const reviewers = allUsers.filter(u => u.role === "head_of_moderation" || u.role === "founder");

      for (const reviewer of reviewers) {
        await storage.createNotification({
          userId: reviewer.id,
          type: "pto_request",
          title: "New Moderator PTO Request",
          message: `${user?.username || "A moderator"} has requested PTO from ${validated.startDate} to ${validated.endDate}`,
          relatedId: request.id,
          sourceType: "system",
          sourceId: request.id,
        });
      }

      res.json(request);
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Invalid PTO request data" });
    }
  });

  // Invitation routes
  app.post("/api/jobs/:jobId/invite", requireAuth, async (req, res) => {
    try {
      const { userId } = req.body;
      const jobId = req.params.jobId;

      const job = await storage.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if requester owns or works on the job
      if (job.customerId !== req.session.userId && job.freelancerId !== req.session.userId) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const invitation = await storage.createInvitation({
        jobId,
        fromUserId: req.session.userId!,
        toUserId: userId,
        status: "pending",
      });

      // Send in-app notification to invited user
      const sender = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId,
        type: "invitation",
        title: "Team invitation",
        message: `${sender?.username} has invited you to collaborate on "${job.title}". Check your invitations to respond.`,
        relatedId: invitation.id,
        sourceType: "job",
        sourceId: job.id,
      });


      res.json(invitation);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Project leader proposes inviting a freelancer — goes to the customer for approval first,
  // and only after approval is the freelancer actually invited.
  app.post("/api/jobs/:jobId/propose-invite", requireAuth, async (req, res) => {
    try {
      const { userId, message } = req.body;
      const jobId = req.params.jobId;

      const job = await storage.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Only the project leader can propose an invite
      const projectLeaderId = job.projectLeaderId || job.freelancerId;
      if (!projectLeaderId || req.session.userId !== projectLeaderId) {
        return res.status(403).json({ error: "Only the project leader can invite freelancers" });
      }

      const takenStatuses = ["claimed", "in_progress", "submitted", "awaiting_customer", "deadline_reached"];
      if (!takenStatuses.includes(job.status)) {
        return res.status(400).json({ error: "This job is not active right now" });
      }

      const invited = await storage.getUser(userId);
      if (!invited) {
        return res.status(404).json({ error: "Freelancer not found" });
      }
      if (invited.role !== "freelancer") {
        return res.status(400).json({ error: "You can only invite freelancers" });
      }

      // Can't invite someone already on the job
      if (job.freelancerId === userId || (job.collaborators || []).includes(userId)) {
        return res.status(400).json({ error: "This freelancer is already on the job" });
      }

      // No duplicate recommendation already awaiting the customer's review
      const existingRecs = await storage.getJobRecommendationsByRecommender(req.session.userId!);
      const alreadyRecommended = existingRecs.find(
        (r) => r.recommendedFreelancerId === userId && r.jobId === jobId && r.status === "pending"
      );
      if (alreadyRecommended) {
        return res.status(400).json({ error: "An invite for this freelancer is already awaiting customer review" });
      }

      // The invite is a job recommendation — it lands in the customer's Recommendations tab
      const recommendation = await storage.createJobRecommendation({
        recommenderId: req.session.userId!,
        recommendedFreelancerId: userId,
        jobId,
        customerId: job.customerId,
        recommenderMessage: message || null,
      });

      // Notify the customer — routes them to their Recommendations
      const leader = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: job.customerId,
        type: "job_recommendation",
        title: "Freelancer Recommendation",
        message: `${leader?.username} recommends ${invited.username} for your job: ${job.title}`,
        relatedId: recommendation.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true, recommendation });
    } catch (error) {
      console.error("Error proposing invite:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/invitations", requireAuth, async (req, res) => {
    try {
      const invitations = await storage.getInvitations(req.session.userId!);
      res.json(invitations);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get enriched direct team invitations for freelancer (pending invitations from Offer Team feature)
  app.get("/api/invitations/pending", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can view pending invitations" });
      }

      const allInvitations = await storage.getInvitations(user.id);
      // Filter to only pending invitations where user is the recipient
      // Include both "pending" status and null status (for backwards compatibility)
      const pendingInvitations = allInvitations.filter(
        inv => inv.toUserId === user.id && (inv.status === "pending" || inv.status === null)
      );

      // Enrich with user and job data
      const enrichedPromises = pendingInvitations.map(async (inv) => {
        const fromUser = await storage.getUser(inv.fromUserId);
        const job = await storage.getJob(inv.jobId);
        
        // Skip invitations with missing job data
        if (!job) return null;
        
        // Get customer from job (not from sender)
        const customer = await storage.getUser(job.customerId);
        
        // Get current team members for this job
        let teamMembers: Array<{id: string; username: string; avatar: string | null; level: number}> = [];
        if (job.freelancerId) {
          const mainFreelancer = await storage.getUser(job.freelancerId);
          if (mainFreelancer) {
            teamMembers.push({
              id: mainFreelancer.id,
              username: mainFreelancer.username,
              avatar: mainFreelancer.avatar,
              level: mainFreelancer.level || 1,
            });
          }
        }
        const jobFreelancers = await storage.getJobFreelancers(job.id);
        for (const jf of jobFreelancers) {
          const fl = await storage.getUser(jf.freelancerId);
          if (fl && !teamMembers.find(tm => tm.id === fl.id)) {
            teamMembers.push({
              id: fl.id,
              username: fl.username,
              avatar: fl.avatar,
              level: fl.level || 1,
            });
          }
        }
        
        // Calculate estimated split
        const currentTeamSize = teamMembers.length;
        const estimatedSplitCount = currentTeamSize + 1;
        const jobBudget = parseFloat(job.budget) || 0;
        const baseShare = estimatedSplitCount > 0 ? jobBudget / estimatedSplitCount : 0;
        const invitedLevel = user.level || 1;
        const levelPayout = getLevelPayout(invitedLevel);
        const estimatedShare = baseShare * levelPayout;
        
        return {
          id: inv.id,
          type: "direct_invitation" as const,
          status: inv.status || "pending",
          createdAt: inv.createdAt,
          inviter: fromUser ? {
            id: fromUser.id,
            username: fromUser.username,
            avatar: fromUser.avatar,
          } : null,
          customer: customer ? {
            id: customer.id,
            username: customer.username,
            avatar: customer.avatar,
          } : null,
          job: {
            id: job.id,
            title: job.title,
            description: job.description,
            budget: job.budget,
            category: job.category,
            deadline: job.deadline,
          },
          teamMembers,
          currentTeamSize,
          estimatedShare: estimatedShare.toFixed(2),
        };
      });
      
      const enrichedResults = await Promise.all(enrichedPromises);
      // Filter out null results (missing job data)
      const enriched = enrichedResults.filter(item => item !== null);

      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/invitations/:id/accept", requireAuth, async (req, res) => {
    try {
      // First check if freelancer is already assigned to an active job
      const allJobs = await storage.getJobs({});
      const userId = req.session.userId!;
      const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted"];
      
      const assignedActiveJobs = allJobs.filter(j => {
        if (!activeStatuses.includes(j.status)) return false;
        if (j.freelancerId === userId) return true;
        if (j.teamMembers?.includes(userId)) return true;
        if (j.collaborators?.includes(userId)) return true;
        return false;
      });

      if (assignedActiveJobs.length > 0) {
        return res.status(400).json({ error: "You are already assigned to an active job. Complete it before accepting new invitations." });
      }

      // Also check jobFreelancers table for multi-freelancer assignments
      const jobFreelancerAssignments = await storage.getJobFreelancersByFreelancer(userId);
      for (const jf of jobFreelancerAssignments) {
        const assignedJob = await storage.getJob(jf.jobId);
        if (assignedJob && activeStatuses.includes(assignedJob.status)) {
          return res.status(400).json({ error: "You are already assigned to an active job. Complete it before accepting new invitations." });
        }
      }

      const existingInvitation = await storage.getInvitation(req.params.id);
      if (!existingInvitation) {
        return res.status(404).json({ error: "Invitation not found" });
      }
      if (existingInvitation.toUserId !== req.session.userId) {
        return res.status(403).json({ error: "This invitation is not addressed to you" });
      }
      if (existingInvitation.status !== "pending" && existingInvitation.status !== null) {
        return res.status(400).json({ error: "This invitation can no longer be accepted" });
      }

      const invitation = await storage.updateInvitation(req.params.id, { 
        status: "accepted" 
      });
      
      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found" });
      }

      // Add user to job collaborators
      const job = await storage.getJob(invitation.jobId);
      if (job) {
        const collaborators = job.collaborators || [];
        if (!collaborators.includes(req.session.userId!)) {
          collaborators.push(req.session.userId!);
          await storage.updateJob(job.id, { collaborators });
        }
      }

      // Notify sender that invitation was accepted
      const accepter = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: invitation.fromUserId,
        type: "invitation",
        title: "Invitation accepted",
        message: `${accepter?.username} accepted your invitation to collaborate on "${job?.title}".`,
        relatedId: invitation.jobId,
        sourceType: "job",
        sourceId: job?.id || null,
      });

      res.json(invitation);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/invitations/:id/reject", requireAuth, async (req, res) => {
    try {
      const existingInvitation = await storage.getInvitation(req.params.id);
      if (!existingInvitation) {
        return res.status(404).json({ error: "Invitation not found" });
      }
      if (existingInvitation.toUserId !== req.session.userId) {
        return res.status(403).json({ error: "This invitation is not addressed to you" });
      }
      if (existingInvitation.status !== "pending" && existingInvitation.status !== null) {
        return res.status(400).json({ error: "This invitation can no longer be rejected" });
      }

      const invitation = await storage.updateInvitation(req.params.id, { 
        status: "rejected" 
      });
      
      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found" });
      }

      // Notify sender that invitation was rejected
      const job = await storage.getJob(invitation.jobId);
      const rejecter = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: invitation.fromUserId,
        type: "invitation",
        title: "Invitation declined",
        message: `${rejecter?.username} declined your invitation to collaborate on "${job?.title}".`,
        relatedId: invitation.jobId,
        sourceType: "job",
        sourceId: job?.id || null,
      });

      res.json(invitation);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer approves a project leader's invite proposal — the freelancer is then actually invited


  // Profile update route (username only - email requires verification)
  app.put("/api/profile", requireAuth, async (req, res) => {
    try {
      const { username } = req.body;
      
      const updates: { username?: string } = {};
      
      if (username && typeof username === "string") {
        const trimmedUsername = username.trim();
        if (trimmedUsername.length < 2 || trimmedUsername.length > 50) {
          return res.status(400).json({ error: "Username must be between 2 and 50 characters" });
        }
        updates.username = trimmedUsername;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }
      
      const user = await storage.updateUser(req.session.userId!, updates);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json({ username: user.username, email: user.email });
    } catch (error) {
      console.error("Profile update error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Email change request - sends verification email
  app.post("/api/profile/email-change", requireAuth, async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required" });
      }
      
      const trimmedEmail = email.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Check if email is same as current
      if (user.email === trimmedEmail) {
        return res.status(400).json({ error: "This is already your current email" });
      }
      
      // Check rate limiting - 10 minute cooldown
      const existingToken = await storage.getEmailVerificationTokenByUserId(user.id);
      if (existingToken) {
        const tokenAge = Date.now() - new Date(existingToken.createdAt!).getTime();
        const cooldownMs = 10 * 60 * 1000; // 10 minutes
        if (tokenAge < cooldownMs) {
          const remainingMinutes = Math.ceil((cooldownMs - tokenAge) / 60000);
          return res.status(429).json({ 
            error: `Please wait ${remainingMinutes} minute(s) before requesting another email change` 
          });
        }
      }
      
      // Delete any existing tokens for this user
      await storage.deleteEmailVerificationTokensByUserId(user.id);
      
      // Generate secure token
      const crypto = await import('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      
      // Store token with 24 hour expiration
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await storage.createEmailVerificationToken({
        userId: user.id,
        token,
        newEmail: trimmedEmail,
        expiresAt,
      });
      
      // Update user with pending email
      await storage.updateUser(user.id, { pendingEmail: trimmedEmail });
      
      // Dev aid: when no email provider is configured, make the verification
      // link retrievable from the server log so the flow stays testable.
      if (!process.env.SENDGRID_API_KEY && !process.env.RESEND_API_KEY && !process.env.REPLIT_CONNECTORS_HOSTNAME) {
        console.log(`[email-verification] No email provider configured. Verification link for ${trimmedEmail}: http://localhost:5000/api/profile/email-verify?token=${token}`);
      }
      
      // Send verification email
      try {
        const { sendVerificationEmail } = await import('./lib/resend-client');
        await sendVerificationEmail(trimmedEmail, token, user.username);
      } catch (emailError: any) {
        console.error('Failed to send verification email:', emailError);
        const msg = String(emailError?.message || '');
        // Surface a misconfigured email provider clearly so the user isn't
        // left wondering why nothing arrives in their inbox.
        if (msg.includes('not set and no Replit connector') || msg.includes('Resend not connected')) {
          return res.status(503).json({
            error: "Email sending is not configured on this server (missing SENDGRID_API_KEY or RESEND_API_KEY). The verification email was not sent — ask the administrator to add an API key. In development you can verify with:\n/api/profile/email-verify?token=<token from server log>",
            pendingEmail: trimmedEmail,
          });
        }
        return res.status(500).json({ error: "Failed to send verification email. Please try again later." });
      }
      
      res.json({ 
        message: "Verification email sent", 
        pendingEmail: trimmedEmail 
      });
    } catch (error) {
      console.error("Email change request error:", error);
      res.status(500).json({ error: "Failed to process email change request" });
    }
  });

  // Email verification - confirms the new email
  app.get("/api/profile/email-verify", async (req, res) => {
    try {
      const { token } = req.query;
      
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "Invalid verification link" });
      }
      
      const verificationToken = await storage.getEmailVerificationToken(token);
      
      // Don't reveal whether token exists or is expired (security)
      if (!verificationToken) {
        return res.status(400).json({ error: "Invalid or expired verification link" });
      }
      
      // Check if token is expired
      if (new Date() > new Date(verificationToken.expiresAt)) {
        return res.status(400).json({ error: "Invalid or expired verification link" });
      }
      
      // Check if token was already used - if recently used, treat as success (handles duplicate requests)
      if (verificationToken.usedAt) {
        const usedAgo = Date.now() - new Date(verificationToken.usedAt).getTime();
        if (usedAgo < 5 * 60 * 1000) {
          return res.json({ 
            success: true, 
            message: "Email verified successfully",
            email: verificationToken.newEmail 
          });
        }
        return res.status(400).json({ error: "This verification link has already been used" });
      }
      
      // Mark token as used
      await storage.markEmailVerificationTokenUsed(token);
      
      // Update user's email
      const user = await storage.updateUser(verificationToken.userId, {
        email: verificationToken.newEmail,
        emailVerified: true,
        pendingEmail: null,
      });
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Create notification for user
      await storage.createNotification({
        userId: user.id,
        type: "system",
        title: "Email verified",
        message: `Your email has been successfully changed to ${verificationToken.newEmail}`,
        sourceType: "system",
        sourceId: null,
      });
      
      res.json({ 
        success: true, 
        message: "Email verified successfully",
        email: verificationToken.newEmail 
      });
    } catch (error) {
      console.error("Email verification error:", error);
      res.status(500).json({ error: "Failed to verify email" });
    }
  });

  // Cancel pending email change
  app.delete("/api/profile/email-change", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Delete any pending tokens
      await storage.deleteEmailVerificationTokensByUserId(user.id);
      
      // Clear pending email
      await storage.updateUser(user.id, { pendingEmail: null });
      
      res.json({ message: "Email change cancelled" });
    } catch (error) {
      console.error("Cancel email change error:", error);
      res.status(500).json({ error: "Failed to cancel email change" });
    }
  });

  // Working Hours routes
  app.get("/api/profile/working-hours", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(user.workingHours || {});
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/profile/working-hours", requireAuth, async (req, res) => {
    try {
      const validatedHours = workingHoursSchema.parse(req.body);
      
      // Validate end time is after start time for each day
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      for (const day of days) {
        const dayHours = validatedHours[day as keyof typeof validatedHours];
        if (dayHours?.start && dayHours?.end) {
          const [startHour, startMin] = dayHours.start.split(':').map(Number);
          const [endHour, endMin] = dayHours.end.split(':').map(Number);
          const startMinutes = startHour * 60 + startMin;
          const endMinutes = endHour * 60 + endMin;
          
          if (endMinutes <= startMinutes) {
            return res.status(400).json({ 
              error: `End time must be after start time for ${day.charAt(0).toUpperCase() + day.slice(1)}` 
            });
          }
        }
      }
      
      const user = await storage.updateUser(req.session.userId!, {
        workingHours: validatedHours,
      });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(user.workingHours);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid working hours format", details: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/profile/avatar", requireAuth, async (req, res) => {
    try {
      const { avatar } = req.body;
      
      if (!avatar || typeof avatar !== "string") {
        return res.status(400).json({ error: "No image data provided. Please select an image file." });
      }

      if (!avatar.startsWith("data:image/")) {
        return res.status(400).json({ error: "Invalid file format. Please upload an image file." });
      }

      // Validate specific image formats
      const validFormats = ["data:image/png", "data:image/jpeg", "data:image/jpg", "data:image/gif", "data:image/webp"];
      const isValidFormat = validFormats.some(format => avatar.startsWith(format));
      
      if (!isValidFormat) {
        return res.status(400).json({ 
          error: "Unsupported image format. Please use PNG, JPG, GIF, or WebP." 
        });
      }

      // Check for reasonable file size (base64 is ~33% larger than original)
      // 5MB original = ~6.7MB base64
      const maxBase64Size = 7 * 1024 * 1024;
      if (avatar.length > maxBase64Size) {
        return res.status(400).json({ 
          error: "Image file is too large. Maximum size is 5MB." 
        });
      }

      const user = await storage.updateUser(req.session.userId!, { avatar });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ avatar: user.avatar });
    } catch (error) {
      console.error("Avatar upload error:", error);
      res.status(500).json({ error: "Failed to upload image. Please try again." });
    }
  });

  app.put("/api/profile/specialization", requireRole("freelancer"), async (req, res) => {
    try {
      const { specialization } = req.body;
      
      if (!specialization || typeof specialization !== "string") {
        return res.status(400).json({ error: "Invalid specialization" });
      }

      const trimmed = specialization.trim();
      if (!trimmed) {
        return res.status(400).json({ error: "Specialization cannot be empty" });
      }

      if (trimmed.length > 100) {
        return res.status(400).json({ error: "Specialization must be 100 characters or less" });
      }

      const user = await storage.updateUser(req.session.userId!, { specialization: trimmed });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ specialization: user.specialization });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/profile/portfolio", requireRole("freelancer"), async (req, res) => {
    try {
      const { portfolio } = req.body;

      if (portfolio === undefined || portfolio === null || typeof portfolio !== "string") {
        return res.status(400).json({ error: "Invalid portfolio" });
      }

      const trimmed = portfolio.trim();
      if (trimmed.length > 300) {
        return res.status(400).json({ error: "Portfolio URL must be 300 characters or less" });
      }

      if (trimmed && !/^https?:\/\/.+/i.test(trimmed)) {
        return res.status(400).json({ error: "Portfolio must be a valid http(s) URL" });
      }

      const user = await storage.updateUser(req.session.userId!, { portfolio: trimmed || null });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ portfolio: user.portfolio });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/profile/bio", requireAuth, async (req, res) => {
    try {
      const { bio } = req.body;
      
      if (bio !== undefined && typeof bio !== "string") {
        return res.status(400).json({ error: "Invalid bio format" });
      }

      const trimmed = bio ? bio.trim() : "";
      const sanitized = sanitizeText(trimmed);
      
      if (sanitized.length > 500) {
        return res.status(400).json({ error: "Bio must be 500 characters or less" });
      }

      const user = await storage.updateUser(req.session.userId!, { bio: sanitized || null });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ bio: user.bio });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/profile/stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.role === "customer") {
        const allJobs = await storage.getJobs({ customerId: user.id });
        const completedJobs = allJobs.filter(j => j.status === "completed");
        const cancelledJobs = allJobs.filter(j => j.status === "cancelled");
        const totalSpent = completedJobs.reduce((sum, j) => sum + (Number(j.budget) || 0) + (Number(j.premiumAmount) || 0), 0);
        
        // Calculate cancellation rate
        const totalFinishedJobs = completedJobs.length + cancelledJobs.length;
        const cancellationRate = totalFinishedJobs > 0 
          ? (cancelledJobs.length / totalFinishedJobs * 100).toFixed(1)
          : "0.0";
        
        // Calculate reliability score (based on completion rate and job history)
        let reliabilityScore = 10;
        if (totalFinishedJobs > 0) {
          const completionRatio = completedJobs.length / totalFinishedJobs;
          reliabilityScore = Math.round(completionRatio * 10);
        }
        
        // Calculate account age in days
        const accountAge = user.createdAt 
          ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000))
          : 0;
        
        res.json({
          totalJobsPosted: allJobs.length,
          completedJobs: completedJobs.length,
          activeJobs: allJobs.filter(j => ["active", "in_progress", "claimed"].includes(j.status)).length,
          pendingJobs: allJobs.filter(j => j.status === "pending").length,
          totalSpent,
          cancellationRate: parseFloat(cancellationRate),
          reliabilityScore,
          accountAgeDays: accountAge,
          isVerified: (completedJobs.length >= 3 && reliabilityScore >= 7),
        });
      } else if (user.role === "moderator" || user.role === "staff") {
        const allJobs = await storage.getJobs({});
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const approvedJobs = allJobs.filter(j => j.status === "active" || j.status === "completed" || j.status === "in_progress" || j.status === "claimed");
        const approvedToday = approvedJobs.filter(j => {
          if (!j.updatedAt) return false;
          const updatedDate = new Date(j.updatedAt);
          updatedDate.setHours(0, 0, 0, 0);
          return updatedDate.getTime() === today.getTime();
        }).length;
        
        // Get reports reviewed by this moderator
        const allReports = await storage.getReports({ status: "resolved" });
        const casesReviewed = allReports.filter(r => r.reviewerId === user.id).length;
        
        // Calculate account age in days
        const accountAge = user.createdAt 
          ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000))
          : 0;
        
        // Calculate moderator tier based on cases reviewed
        let moderatorTier = "Bronze";
        if (casesReviewed >= 100) moderatorTier = "Diamond";
        else if (casesReviewed >= 50) moderatorTier = "Gold";
        else if (casesReviewed >= 20) moderatorTier = "Silver";
        
        res.json({
          totalJobsModerated: approvedJobs.length,
          pendingQueue: allJobs.filter(j => j.status === "pending").length,
          approvedToday,
          casesReviewed,
          moderatorTier,
          accountAgeDays: accountAge,
          isVerified: true,
          moderatorStatus: "Active",
        });
      } else {
        res.json({
          completedJobs: user.completedJobs || 0,
          level: user.level || 1,
          rating: user.rating,
          completionPercentage: user.completionPercentage || 0,
        });
      }
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Job Team Members endpoint (for chat partner selection)
  app.get("/api/jobs/:jobId/team-members", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const teamMembers: Array<{ id: string; username: string; avatar: string | null }> = [];

      // Add lead freelancer
      if (job.freelancerId) {
        const lead = await storage.getUser(job.freelancerId);
        if (lead) {
          teamMembers.push({ id: lead.id, username: lead.username, avatar: lead.avatar });
        }
      }

      // Add collaborators
      if (job.collaborators) {
        for (const collabId of job.collaborators) {
          if (!teamMembers.find(tm => tm.id === collabId)) {
            const collab = await storage.getUser(collabId);
            if (collab) {
              teamMembers.push({ id: collab.id, username: collab.username, avatar: collab.avatar });
            }
          }
        }
      }

      // Add from jobFreelancers table (multi-freelancer assignments)
      const jobFreelancers = await storage.getJobFreelancers(req.params.jobId);
      for (const jf of jobFreelancers) {
        if (!teamMembers.find(tm => tm.id === jf.freelancerId)) {
          const fl = await storage.getUser(jf.freelancerId);
          if (fl) {
            teamMembers.push({ id: fl.id, username: fl.username, avatar: fl.avatar });
          }
        }
      }

      res.json(teamMembers);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Chat Message routes
  app.get("/api/jobs/:jobId/chat", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Verify user is part of the job (freelancer, collaborator, team member, or customer)
      const userId = req.session.userId!;
      const isCustomer = job.customerId === userId;
      const isFreelancer = job.freelancerId === userId;
      const isCollaborator = job.collaborators?.includes(userId);
      
      // Also check jobFreelancers table for multi-freelancer team members
      const jobFreelancerRecords = await storage.getJobFreelancers(req.params.jobId);
      const isTeamMember = jobFreelancerRecords.some(jf => jf.freelancerId === userId);

      if (!isCustomer && !isFreelancer && !isCollaborator && !isTeamMember) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Get the partner ID from query param (for 1-on-1 private chats)
      const partnerId = req.query.partnerId as string | undefined;
      
      const allMessages = await storage.getChatMessages(req.params.jobId);
      
      // Filter to only show messages between current user and their chat partner
      let messages = allMessages;
      if (partnerId) {
        // Show only messages between userId and partnerId
        messages = allMessages.filter(
          (msg) =>
            (msg.senderId === userId && msg.receiverId === partnerId) ||
            (msg.senderId === partnerId && msg.receiverId === userId)
        );
      } else {
        // If no partner specified, show messages where current user is sender or receiver
        messages = allMessages.filter(
          (msg) => msg.senderId === userId || msg.receiverId === userId
        );
      }
      
      // Mark messages as read for current user
      await storage.markChatMessagesAsRead(req.params.jobId, userId);

      // Enrich messages with sender info
      const enrichedMessages = await Promise.all(
        messages.map(async (msg) => {
          const sender = await storage.getUser(msg.senderId);
          return {
            ...msg,
            senderUsername: sender?.username || "Unknown",
            senderAvatar: sender?.avatar || null,
            senderRole: sender?.role || null,
          };
        })
      );

      res.json(enrichedMessages);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/jobs/:jobId/chat", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const userId = req.session.userId!;
      const { message, receiverId: specifiedReceiverId } = req.body;

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Message is required" });
      }

      // Verify user is part of the job (including team members from jobFreelancers)
      const isCustomer = job.customerId === userId;
      const isFreelancer = job.freelancerId === userId;
      const isCollaborator = job.collaborators?.includes(userId);
      
      // Also check jobFreelancers table for multi-freelancer team members
      const jobFreelancerRecords = await storage.getJobFreelancers(req.params.jobId);
      const isTeamMember = jobFreelancerRecords.some(jf => jf.freelancerId === userId);

      if (!isCustomer && !isFreelancer && !isCollaborator && !isTeamMember) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Determine receiver - use specified receiverId if provided, otherwise default logic
      let receiverId: string;
      if (specifiedReceiverId) {
        receiverId = specifiedReceiverId;
      } else {
        // Default: customer sends to lead freelancer, freelancer sends to customer
        receiverId = isCustomer ? job.freelancerId! : job.customerId;
      }

      const chatMessage = await storage.createChatMessage({
        jobId: req.params.jobId,
        senderId: userId,
        receiverId,
        message: message.trim(),
      });

      // Create notification for receiver. The master "Enable Notifications"
      // switch is a *delivery* preference, not an inbox filter: notifications
      // must always enter the inbox so the user sees them when they re-enable
      // notifications. The client suppresses the red badge growth and sounds.
      const sender = await storage.getUser(userId);
      await storage.createNotification({
        userId: receiverId,
        type: "chat_message",
        title: "New message",
        message: `${sender?.username} sent you a message`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json(chatMessage);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Notifications routes
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const includeAll = req.query.all === "true";
      const notifications = await storage.getNotifications(req.session.userId!, includeAll);
      res.json(notifications);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
    try {
      const count = await storage.getUnreadNotificationCount(req.session.userId!);
      res.json({ count });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const notification = await storage.markNotificationAsRead(req.params.id);
      if (!notification) {
        return res.status(404).json({ error: "Notification not found" });
      }
      res.json(notification);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/notifications/mark-all-read", requireAuth, async (req, res) => {
    try {
      await storage.markAllNotificationsAsRead(req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/notifications/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteNotification(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Clear all notifications for the authenticated user
  app.delete("/api/notifications", requireAuth, async (req, res) => {
    try {
      await storage.deleteAllNotifications(req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dismiss a single notification from bell popover (hides from popover, keeps in log)
  app.put("/api/notifications/:id/dismiss", requireAuth, async (req, res) => {
    try {
      await storage.dismissNotification(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dismiss all notifications from bell popover (hides from popover, keeps in log)
  app.put("/api/notifications/dismiss-all", requireAuth, async (req, res) => {
    try {
      await storage.dismissAllNotifications(req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // === USER PREFERENCES ROUTES ===

  app.get("/api/settings", requireAuth, async (req, res) => {
    try {
      let prefs = await storage.getUserPreferences(req.session.userId!);
      if (!prefs) {
        prefs = await storage.createUserPreferences({ userId: req.session.userId! });
      }
      res.json(prefs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    try {
      const updates = req.body;
      let prefs = await storage.getUserPreferences(req.session.userId!);
      if (!prefs) {
        prefs = await storage.createUserPreferences({ userId: req.session.userId!, ...updates });
      } else {
        prefs = await storage.updateUserPreferences(req.session.userId!, updates);
      }
      res.json(prefs);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/settings/deactivate-account", requireAuth, async (req, res) => {
    try {
      const prefs = await storage.updateUserPreferences(req.session.userId!, {
        accountDeactivated: true,
        deactivatedAt: new Date(),
      });
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).json({ error: "Failed to log out" });
        }
        res.json({ success: true, message: "Account deactivated" });
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/settings/download-data", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      const wallet = await storage.getWallet(req.session.userId!);
      const jobs = await storage.getJobs({ freelancerId: req.session.userId });
      const notifications = await storage.getNotifications(req.session.userId!);
      const prefs = await storage.getUserPreferences(req.session.userId!);
      
      const userData = {
        user: user ? { ...user } : null,
        wallet,
        jobs,
        notifications,
        preferences: prefs,
        exportedAt: new Date().toISOString(),
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="linxova-data-${req.session.userId}.json"`);
      res.json(userData);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // User search for job invitations (search freelancers by name)
  app.get("/api/users/search-freelancers", requireAuth, async (req, res) => {
    try {
      const { query } = req.query;
      
      if (!query || typeof query !== 'string') {
        return res.json([]);
      }

      // Simple search by username - in production would use proper search
      const allUsers = Array.from((storage as any).users.values());
      const results = allUsers
        .filter((user: any) => 
          user.username.toLowerCase().includes(query.toLowerCase()) &&
          user.id !== req.session.userId &&
          user.role === "freelancer"
        )
        .slice(0, 10)
        .map((user: any) => ({
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          specialization: user.specialization,
        }));

      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // === CUSTOMER BLACKLIST ROUTES ===

  // Get customer's blacklist
  app.get("/api/blacklist", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "customer") {
        return res.status(403).json({ error: "Only customers can manage blacklists" });
      }

      const blacklistedIds = user.blacklistedFreelancers || [];
      
      // Enrich with freelancer details
      const blacklistedUsers = await Promise.all(
        blacklistedIds.map(async (freelancerId: string) => {
          const freelancer = await storage.getUser(freelancerId);
          return freelancer ? {
            id: freelancer.id,
            userId: freelancer.userId,
            username: freelancer.username,
            avatar: freelancer.avatar,
            level: freelancer.level,
            rating: freelancer.rating,
          } : null;
        })
      );

      res.json(blacklistedUsers.filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Add freelancer to blacklist
  app.post("/api/blacklist/:freelancerId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "customer") {
        return res.status(403).json({ error: "Only customers can manage blacklists" });
      }

      const freelancer = await storage.getUser(req.params.freelancerId);
      if (!freelancer) {
        return res.status(404).json({ error: "Freelancer not found" });
      }
      if (freelancer.role !== "freelancer") {
        return res.status(400).json({ error: "Can only blacklist freelancers" });
      }

      const currentBlacklist = user.blacklistedFreelancers || [];
      if (currentBlacklist.includes(req.params.freelancerId)) {
        return res.status(400).json({ error: "Freelancer is already blacklisted" });
      }

      await storage.updateUser(req.session.userId!, {
        blacklistedFreelancers: [...currentBlacklist, req.params.freelancerId],
      });

      res.json({ success: true, message: `${freelancer.username} has been blacklisted` });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove freelancer from blacklist
  app.delete("/api/blacklist/:freelancerId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "customer") {
        return res.status(403).json({ error: "Only customers can manage blacklists" });
      }

      const currentBlacklist = user.blacklistedFreelancers || [];
      if (!currentBlacklist.includes(req.params.freelancerId)) {
        return res.status(400).json({ error: "Freelancer is not in your blacklist" });
      }

      await storage.updateUser(req.session.userId!, {
        blacklistedFreelancers: currentBlacklist.filter((id: string) => id !== req.params.freelancerId),
      });

      res.json({ success: true, message: "Freelancer has been removed from blacklist" });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // === ROLE UPGRADE REQUEST ROUTES ===

  // Get current user's role upgrade requests
  app.get("/api/role-upgrade-requests/my", requireAuth, async (req, res) => {
    try {
      const requests = await storage.getRoleUpgradeRequests({ userId: req.session.userId });
      res.json(requests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get pending role upgrade requests (moderators only)
  app.get("/api/role-upgrade-requests/pending", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const requests = await storage.getPendingRoleUpgradeRequests();
      
      // Enrich with user data
      const enrichedRequests = await Promise.all(
        requests.map(async (request) => {
          const user = await storage.getUser(request.userId);
          return {
            ...request,
            user: user ? {
              id: user.id,
              username: user.username,
              avatar: user.avatar,
              role: user.role,
              completedJobs: user.completedJobs,
              level: user.level,
              rating: user.rating,
              portfolio: user.portfolio,
            } : null,
          };
        })
      );
      
      res.json(enrichedRequests);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Submit a role upgrade request
  app.post("/api/role-upgrade-requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const validatedData = insertRoleUpgradeRequestSchema.parse({
        ...req.body,
        userId: user.id,
      });

      // Validate upgrade type matches current role
      if (validatedData.upgradeType === RoleUpgradeType.CUSTOMER_TO_FREELANCER) {
        if (user.role !== UserRole.CUSTOMER) {
          return res.status(400).json({ error: "Only customers can request freelancer upgrade" });
        }
        
        // Customer to Freelancer: Must have no active jobs
        const customerJobs = await storage.getJobs({ customerId: user.id });
        const activeStatuses = [
          JobStatus.DRAFT, JobStatus.PENDING_APPROVAL, JobStatus.PENDING_ACCEPTANCE,
          JobStatus.IN_PROGRESS, JobStatus.SUBMITTED, JobStatus.AWAITING_CUSTOMER,
          JobStatus.DISPUTE, JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.FREELANCER_REQUESTED,
          JobStatus.CLAIMED, JobStatus.CHANGES_REQUESTED
        ];
        const activeJobs = customerJobs.filter(j => activeStatuses.includes(j.status as any));
        if (activeJobs.length > 0) {
          return res.status(400).json({
            error: `You cannot request a role upgrade while you have ${activeJobs.length} active job(s). Please complete or cancel all your jobs first.`
          });
        }

        // Customer to Freelancer: Account must be at least 3 days old
        if (user.createdAt) {
          const accountAge = Date.now() - new Date(user.createdAt).getTime();
          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
          if (accountAge < threeDaysMs) {
            const daysRemaining = Math.ceil((threeDaysMs - accountAge) / (24 * 60 * 60 * 1000));
            return res.status(400).json({ 
              error: `Your account must be at least 3 days old to become a freelancer. ${daysRemaining} day(s) remaining.` 
            });
          }
        }
      } else if (validatedData.upgradeType === RoleUpgradeType.FREELANCER_TO_MODERATOR) {
        if (user.role !== UserRole.FREELANCER) {
          return res.status(400).json({ error: "Only freelancers can request moderator upgrade" });
        }
        
        // Freelancer to Moderator requirements:
        // 1. Account must be at least 4 months old
        if (user.createdAt) {
          const accountAge = Date.now() - new Date(user.createdAt).getTime();
          const fourMonthsMs = 120 * 24 * 60 * 60 * 1000; // ~4 months
          if (accountAge < fourMonthsMs) {
            const daysRemaining = Math.ceil((fourMonthsMs - accountAge) / (24 * 60 * 60 * 1000));
            return res.status(400).json({ 
              error: `Your account must be at least 4 months old to become a moderator. ${daysRemaining} day(s) remaining.` 
            });
          }
        }
        
        // 2. Must be level 5
        if ((user.level || 1) < 5) {
          return res.status(400).json({ 
            error: `You must reach Level 5 to become a moderator. You are currently Level ${user.level || 1}.` 
          });
        }
        
        // 3. Must have 65%+ completion rate
        const completionRate = parseFloat(user.completionPercentage?.toString() || "0");
        if (completionRate < 65) {
          return res.status(400).json({ 
            error: `You need a 65% or higher completion rate to become a moderator. Your current rate is ${completionRate.toFixed(1)}%.` 
          });
        }
      }

      // Check for existing pending request
      const existingRequests = await storage.getRoleUpgradeRequests({ 
        userId: user.id, 
        status: RoleUpgradeStatus.PENDING 
      });
      if (existingRequests.length > 0) {
        return res.status(400).json({ error: "You already have a pending upgrade request" });
      }

      const request = await storage.createRoleUpgradeRequest(validatedData);

      // Create notification for moderators
      const moderators = (await storage.getUsers()).filter(u => u.role === "moderator");
      for (const mod of moderators) {
        await storage.createNotification({
          userId: mod.id,
          type: "role_upgrade",
          title: "New Role Upgrade Request",
          message: `${user.username} has requested to become a ${validatedData.upgradeType === RoleUpgradeType.CUSTOMER_TO_FREELANCER ? 'freelancer' : 'moderator'}`,
          relatedId: request.id,
          sourceType: "user",
          sourceId: user.id,
          redirectUrl: "/moderation?tab=upgrades",
        });
      }

      res.status(201).json(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Approve or reject a role upgrade request
  // Moderators can only approve customer-to-freelancer upgrades
  // Founder/Head of Moderation can approve all upgrades including freelancer-to-moderator
  app.patch("/api/role-upgrade-requests/:id", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reviewNotes } = req.body;

      if (!status || !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be 'approved' or 'rejected'" });
      }

      const request = await storage.getRoleUpgradeRequest(id);
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== RoleUpgradeStatus.PENDING) {
        return res.status(400).json({ error: "This request has already been processed" });
      }

      // Check if this is a freelancer-to-moderator upgrade
      // Only Founder and Head of Moderation can approve these
      if (request.upgradeType === RoleUpgradeType.FREELANCER_TO_MODERATOR) {
        const reviewer = await storage.getUser(req.session.userId!);
        if (!reviewer || (reviewer.role !== UserRole.FOUNDER && reviewer.role !== UserRole.HEAD_OF_MODERATION)) {
          return res.status(403).json({ 
            error: "Only the Founder or Head of Moderation can approve moderator promotions" 
          });
        }
      }

      // If approving a customer-to-freelancer upgrade, verify no active jobs
      if (status === "approved" && request.upgradeType === RoleUpgradeType.CUSTOMER_TO_FREELANCER) {
        const customerJobs = await storage.getJobs({ customerId: request.userId });
        const activeStatuses = [
          JobStatus.DRAFT, JobStatus.PENDING_APPROVAL, JobStatus.PENDING_ACCEPTANCE,
          JobStatus.IN_PROGRESS, JobStatus.SUBMITTED, JobStatus.AWAITING_CUSTOMER,
          JobStatus.DISPUTE, JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.FREELANCER_REQUESTED,
          JobStatus.CLAIMED, JobStatus.CHANGES_REQUESTED
        ];
        const activeJobs = customerJobs.filter(j => activeStatuses.includes(j.status as any));
        if (activeJobs.length > 0) {
          return res.status(400).json({
            error: `Cannot approve: this customer still has ${activeJobs.length} active job(s). They must complete or cancel all jobs before being promoted.`
          });
        }
      }

      // Update the request
      const updatedRequest = await storage.updateRoleUpgradeRequest(id, {
        status,
        reviewerId: req.session.userId,
        reviewNotes: reviewNotes || null,
      });

      // If approved, update the user's role
      if (status === "approved") {
        // Role upgrade can only result in FREELANCER or MODERATOR
        // NEVER Founder or Head of Moderation (those are assigned differently)
        const newRole = request.upgradeType === RoleUpgradeType.CUSTOMER_TO_FREELANCER 
          ? UserRole.FREELANCER 
          : UserRole.MODERATOR;
        
        await storage.updateUser(request.userId, { role: newRole });

        // Notify the user
        await storage.createNotification({
          userId: request.userId,
          type: "role_upgrade",
          title: "Role Upgrade Approved!",
          message: `Congratulations! Your request to become a ${newRole} has been approved.`,
          relatedId: request.id,
          sourceType: "user",
          sourceId: request.userId,
          redirectUrl: "/profile",
        });
      } else {
        // Notify the user of rejection
        await storage.createNotification({
          userId: request.userId,
          type: "role_upgrade",
          title: "Role Upgrade Request Declined",
          message: `Your role upgrade request was declined. ${reviewNotes ? `Reason: ${reviewNotes}` : 'Please contact support for more information.'}`,
          relatedId: request.id,
          sourceType: "user",
          sourceId: request.userId,
          redirectUrl: "/profile",
        });
      }

      res.json(updatedRequest);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // === LINO AI ASSISTANT ===
  const linoRateLimits = new Map<string, number[]>();
  const linoOpenaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const linoOpenai = linoOpenaiKey ? new OpenAI({
    apiKey: linoOpenaiKey,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  }) : null;
  const linoOpenaiModel = process.env.AI_INTEGRATIONS_OPENAI_MODEL || "gpt-4o-mini";

  app.post("/api/lino/chat", requireAuth, async (req, res) => {
    const userId = req.session.userId!;

    // Rate limit: max 20 messages per hour
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const userTimestamps = (linoRateLimits.get(userId) || []).filter(t => t > oneHourAgo);
    if (userTimestamps.length >= 20) {
      return res.status(429).json({
        error: "You've sent too many messages to Lino recently. Please wait before trying again."
      });
    }
    userTimestamps.push(now);
    linoRateLimits.set(userId, userTimestamps);

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages are required" });
    }

    const rawMessages = messages.slice(-20);
    const recentMessages = rawMessages.map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").trim(),
    }));

    console.log("[Lino] incoming chat request", {
      userId,
      messageCount: recentMessages.length,
      recentPreview: recentMessages.map((m) => ({ role: m.role, content: m.content.slice(0, 80) })),
      fullPayload: rawMessages.length > 0 ? rawMessages.map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 80) })) : [],
    });

    if (!linoOpenai) {
      recentMessages.filter(m => m.role === "user").forEach((msg) => recordLinoMemory(userId, msg.content));
      const reply = getLinoFallbackReply(recentMessages, userId);
      console.log("[Lino] fallback reply", { reply });
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    try {
      const systemPrompt = `You are Lino, the friendly and helpful AI support assistant for Linxova — a professional freelancer job marketplace platform.

Your role is to help users understand how to use Linxova. Here is what you know about the platform:

**Roles:**
- Customer: Posts jobs, hires freelancers, manages payments
- Freelancer: Applies to jobs, completes work, earns money
- Moderator: Reviews jobs, handles reports, resolves disputes
- Head of Moderation & Founder: Administrative roles with full access

**Job Lifecycle:**
- Customers create jobs (as drafts), then submit for moderator approval
- Budget + premium is deducted from wallet at submission time
- Moderators approve or reject (full refund on rejection)
- Freelancers browse and apply to approved jobs (max 5 pending applications)
- Customer accepts a freelancer, job moves to In Progress
- Freelancer submits work with proof, customer has 4 days to review
- Auto-completes if customer doesn't respond within 4 days

**Wallet & Payments:**
- USD-based wallet with deposit and withdrawal
- Escrow system: money is held until job completes
- Premium listings: minimum $100, premium revenue goes to Linxova
- Level-based payouts: Level 1=65%, Level 2=75%, Level 3=80%, Level 4=85%, Level 5=90%, Level 6=93%, Level 7=95%, Level 8=97% of budget

**Role Upgrades:**
- Customers can apply to become Freelancers (account must be 3+ days old, no active jobs)
- Freelancers can apply for Moderator (Level 5, 65%+ completion rate, 4+ months account age)
- Cannot post new jobs while a role upgrade request is pending

**Features:**
- Friends system for connecting with other users
- Direct messaging with privacy controls
- Notification center for all alerts
- Profile with stats, level, and rating
- PTO requests for freelancers
- Report system for reporting users, jobs, messages, or bugs
- Team collaboration tools for active jobs

**Guidelines for your responses:**
- Be concise, friendly, and helpful
- Use simple language, avoid technical jargon
- If you don't know something specific, say so honestly
- Don't make up features that don't exist
- Don't provide advice on matters outside of Linxova platform usage
- Keep responses focused and under 200 words when possible`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const messagesToSend = [
        { role: "system", content: systemPrompt },
        ...recentMessages
          .filter((m) => m.content.length > 0)
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content).slice(0, 2000),
          })),
      ];

      console.log("[Lino] sending to OpenAI", JSON.stringify(messagesToSend.map((m) => ({ role: m.role, content: m.content.slice(0, 200) })), null, 2));

      const stream = await linoOpenai.chat.completions.create({
        model: linoOpenaiModel,
        messages: messagesToSend,
        stream: true,
        max_completion_tokens: 1024,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      console.error("Lino chat error:", error);
      const friendly =
        error?.status === 429 || error?.code === "insufficient_quota"
          ? "The AI service is temporarily unavailable (quota/rate limit reached). Please try again later."
          : error?.status === 401 || error?.status === 403
          ? "The AI service key is not authorized. Please contact the Linxova admin."
          : "Failed to process your message";
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: friendly });
      }
    }
  });


  // Report routes
  const reportRateLimits = new Map<string, number[]>();

  app.post("/api/reports", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;

      // Rate limit: max 5 reports per hour per user
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const userTimestamps = (reportRateLimits.get(userId) || []).filter(t => t > oneHourAgo);
      if (userTimestamps.length >= 5) {
        return res.status(429).json({
          error: "You've submitted too many reports recently. Please wait before submitting another."
        });
      }
      // Record timestamp immediately to prevent concurrent requests bypassing the limit
      userTimestamps.push(now);
      reportRateLimits.set(userId, userTimestamps);

      // Cap: max 10 pending reports per user at any time
      const existingReports = await storage.getReports({ reporterId: userId });
      const pendingReports = existingReports.filter(r => r.status === "pending");
      if (pendingReports.length >= 10) {
        return res.status(400).json({
          error: "You have too many pending reports. Please wait for existing reports to be reviewed before submitting more."
        });
      }

      const validatedData = insertReportSchema.parse({
        ...req.body,
        reporterId: userId,
      });

      // For user reports with numeric targetId, resolve to internal UUID
      if (validatedData.reportType === "user" && validatedData.targetId !== "platform") {
        // Only treat the target as a numeric user ID when it is entirely digits.
        // Internal user IDs are UUIDs which can start with digits (e.g. "7594fb08-…")
        // — parseInt would mangle those into a bogus sequential lookup and 404.
        if (/^\d+$/.test(validatedData.targetId)) {
          const targetUser = await storage.getUserByUserId(parseInt(validatedData.targetId));
          if (targetUser) {
            validatedData.targetId = targetUser.id;
          } else {
            return res.status(404).json({ error: "No user found with that ID. Please check the user ID and try again." });
          }
        }
      }

      // Prevent duplicate: can't report same target with same type while one is pending
      const duplicateReport = pendingReports.find(
        r => r.targetId === validatedData.targetId && r.reportType === validatedData.reportType
      );
      if (duplicateReport) {
        return res.status(400).json({
          error: "You already have a pending report for this. Please wait for it to be reviewed."
        });
      }

      // Check for spam-like content
      const contentToCheck = `${validatedData.reason} ${validatedData.description || ""}`;
      if (isSpamLike(contentToCheck)) {
        return res.status(400).json({ error: "Report appears to contain spam content" });
      }

      // Check for suspicious/inappropriate content (using "report" context to allow words like "scam")
      const filterResult = filterContent(contentToCheck, "report");
      if (filterResult.severity === "high") {
        return res.status(400).json({ 
          error: "Report contains inappropriate content and cannot be submitted" 
        });
      }

      // Sanitize report content before storage to prevent XSS
      const sanitizedData = {
        ...validatedData,
        reason: sanitizeText(validatedData.reason),
        description: validatedData.description ? sanitizeText(validatedData.description) : null,
      };

      const report = await storage.createReport(sanitizedData);

      // Notify moderators about new report (including head_of_moderation and founder)
      const users = await storage.getUsers();
      const moderators = users.filter(u => ["moderator", "head_of_moderation", "founder", "staff"].includes(u.role));
      for (const mod of moderators) {
        await storage.createNotification({
          userId: mod.id,
          type: "report",
          title: "New Report Submitted",
          message: `A new ${validatedData.reportType} report has been submitted and requires review.`,
          relatedId: report.id,
          sourceType: "report",
          sourceId: report.id,
          redirectUrl: "/moderation?tab=reports",
        });
      }

      res.status(201).json(report);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid report data", details: error.errors });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/reports", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { status, reportType } = req.query;
      const filters: any = {};
      if (status) filters.status = status as string;
      if (reportType) filters.reportType = reportType as string;
      
      const reports = await storage.getReports(filters);
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/reports/pending", requireRole("moderator", "head_of_moderation", "founder", "staff"), async (req, res) => {
    try {
      const reports = await storage.getPendingReports();
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/my-reports", requireAuth, async (req, res) => {
    try {
      const reports = await storage.getReports({ reporterId: req.session.userId });
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/reports/forwarded-bugs", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const reports = await storage.getReports({ status: "forwarded", reportType: "bug" });
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/reports/:id", requireRole("moderator", "head_of_moderation", "founder", "staff"), async (req, res) => {
    try {
      const report = await storage.getReport(req.params.id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/reports/:id", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reviewNotes } = req.body;

      if (!status || !["reviewed", "resolved", "dismissed", "forwarded"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const report = await storage.getReport(id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }

      const sanitizedNotes = reviewNotes ? sanitizeText(reviewNotes) : null;
      
      const updateData: any = {
        status,
        reviewerId: req.session.userId,
        reviewNotes: sanitizedNotes,
      };

      if (status === "forwarded") {
        updateData.forwardedAt = new Date();
      }
      
      const updatedReport = await storage.updateReport(id, updateData);

      await storage.createNotification({
        userId: report.reporterId,
        type: "report",
        title: status === "forwarded" ? "Bug Report Forwarded" : "Report Updated",
        message: status === "forwarded" 
          ? `Your bug report has been forwarded to the development team for review. Thank you for reporting!`
          : `Your report has been ${status}. ${sanitizedNotes ? `Notes: ${sanitizedNotes}` : ''}`,
        relatedId: report.id,
        sourceType: "report",
        sourceId: report.id,
        redirectUrl: "/notifications",
      });

      // When forwarding bugs, notify founder and head_of_moderation
      if (status === "forwarded") {
        const allUsers = await storage.getUsers();
        const leaders = allUsers.filter(u => ["founder", "head_of_moderation"].includes(u.role));
        for (const leader of leaders) {
          await storage.createNotification({
            userId: leader.id,
            type: "forwarded_bug",
            title: "Bug Report Forwarded",
            message: `A bug report has been forwarded to the development team: "${report.reason}"`,
            relatedId: report.id,
            sourceType: "report",
            sourceId: report.id,
            redirectUrl: "/moderation?tab=forwarded-bugs",
          });
        }
      }

      res.json(updatedReport);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Disciplinary action endpoint
  app.post("/api/reports/:id/action", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { action, reason, duration } = req.body;

      if (!action || !["warn", "suspend", "ban"].includes(action)) {
        return res.status(400).json({ error: "Invalid action. Must be warn, suspend, or ban." });
      }
      if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
        return res.status(400).json({ error: "A reason is required (minimum 5 characters)." });
      }

      const report = await storage.getReport(id);
      if (!report) {
        return res.status(404).json({ error: "Report not found" });
      }

      if (report.reportType !== "user") {
        return res.status(400).json({ error: "Disciplinary actions can only be taken on user reports." });
      }

      const targetUser = await storage.getUser(report.targetId);
      if (!targetUser) {
        return res.status(404).json({ error: "Target user not found." });
      }

      const moderator = await storage.getUser(req.session.userId!);
      if (!moderator) {
        return res.status(401).json({ error: "Moderator not found." });
      }

      // Prevent moderators from taking action against equal or higher roles
      const roleHierarchy: Record<string, number> = { 
        freelancer: 1, customer: 1, moderator: 2, head_of_moderation: 3, founder: 4 
      };
      if ((roleHierarchy[targetUser.role] || 0) >= (roleHierarchy[moderator.role] || 0)) {
        return res.status(403).json({ error: "You cannot take disciplinary action against users of equal or higher rank." });
      }

      const sanitizedReason = sanitizeText(reason);

      if (action === "warn") {
        await storage.createNotification({
          userId: targetUser.id,
          type: "system",
          title: "Official Warning",
          message: `You have received an official warning from the moderation team. Reason: ${sanitizedReason}. Please review the platform rules to avoid further action.`,
          relatedId: report.id,
          sourceType: "system",
          sourceId: report.id,
        });
      } else if (action === "suspend") {
        if (!duration || !["1d", "3d", "7d", "14d", "30d"].includes(duration)) {
          return res.status(400).json({ error: "Valid suspension duration required: 1d, 3d, 7d, 14d, or 30d." });
        }
        const daysMap: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 };
        const suspendUntil = new Date();
        suspendUntil.setDate(suspendUntil.getDate() + daysMap[duration]);

        await storage.updateUser(targetUser.id, {
          accountStatus: "suspended",
          suspendedUntil: suspendUntil,
          suspendedReason: sanitizedReason,
        });

        await storage.createNotification({
          userId: targetUser.id,
          type: "system",
          title: "Account Suspended",
          message: `Your account has been suspended for ${duration.replace("d", " day(s)")}. Reason: ${sanitizedReason}`,
          relatedId: report.id,
          sourceType: "system",
          sourceId: report.id,
        });
      } else if (action === "ban") {
        await storage.updateUser(targetUser.id, {
          accountStatus: "banned",
          suspendedReason: sanitizedReason,
        });

        await storage.createUserBan({
          userId: targetUser.id,
          reason: sanitizedReason,
          bannedById: req.session.userId!,
        });

        await storage.createNotification({
          userId: targetUser.id,
          type: "system",
          title: "Account Banned",
          message: `Your account has been permanently banned. Reason: ${sanitizedReason}`,
          relatedId: report.id,
          sourceType: "system",
          sourceId: report.id,
        });
      }

      const actionLabel = action === "warn" ? "Warning issued" : action === "suspend" ? `Suspended for ${duration}` : "Banned";
      await storage.updateReport(id, {
        status: "resolved",
        reviewerId: req.session.userId,
        actionTaken: `${actionLabel}: ${sanitizedReason}`,
        reviewNotes: `Disciplinary action: ${actionLabel}`,
      });

      res.json({ success: true, action: actionLabel });
    } catch (error) {
      console.error("Disciplinary action error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get forwarded bug reports (for founder/head of moderation)
  // Moderator Task routes
  app.get("/api/moderator-tasks", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const tasks = await storage.getModeratorTasks(req.session.userId!);
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/moderator-tasks/assigned-by-me", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const tasks = await storage.getModeratorTasksAssignedBy(req.session.userId!);
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderator-tasks", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const validationResult = insertModeratorTaskSchema.safeParse({
        ...req.body,
        assignedById: req.session.userId!,
      });

      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Validation failed", 
          details: validationResult.error.errors 
        });
      }

      const { title, description, assigneeId, taskType, teamMembers, priority, dueDate } = validationResult.data;

      const assignee = await storage.getUser(assigneeId);
      if (!assignee || (assignee.role !== "moderator" && assignee.role !== "head_of_moderation")) {
        return res.status(400).json({ error: "Assignee must be a moderator" });
      }

      const task = await storage.createModeratorTask({
        title,
        description,
        assignedById: req.session.userId!,
        assigneeId,
        taskType: taskType || "personal",
        teamMembers: teamMembers || null,
        priority: priority || "medium",
        dueDate: dueDate ? new Date(dueDate) : null,
      });

      // Notify the assignee
      await storage.createNotification({
        userId: assigneeId,
        type: "system",
        title: "New Task Assigned",
        message: `You have been assigned a new ${taskType === "team" ? "team" : "personal"} task: ${title}`,
        relatedId: task.id,
        sourceType: "system",
        sourceId: task.id,
      });

      res.status(201).json(task);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/moderator-tasks/:id", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { status, title, description, priority } = req.body;

      // Validate status if provided
      const validStatuses = [ModeratorTaskStatus.PENDING, ModeratorTaskStatus.IN_PROGRESS, ModeratorTaskStatus.COMPLETED];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be one of: pending, in_progress, completed" });
      }

      // Validate priority if provided
      const validPriorities = ["low", "medium", "high"];
      if (priority && !validPriorities.includes(priority)) {
        return res.status(400).json({ error: "Invalid priority. Must be one of: low, medium, high" });
      }

      const task = await storage.getModeratorTask(id);
      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }

      // Only assignee or assigner can update
      const userId = req.session.userId!;
      const isAssignee = task.assigneeId === userId || (task.teamMembers && task.teamMembers.includes(userId));
      const isAssigner = task.assignedById === userId;
      
      if (!isAssignee && !isAssigner) {
        return res.status(403).json({ error: "Not authorized to update this task" });
      }

      const updates: any = {};
      if (status) {
        updates.status = status;
        if (status === ModeratorTaskStatus.COMPLETED) {
          updates.completedAt = new Date();
        } else {
          // Clear completedAt if reverting from completed status
          updates.completedAt = null;
        }
      }
      if (title !== undefined && isAssigner) {
        if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
          return res.status(400).json({ error: "Title must be a non-empty string (max 200 characters)" });
        }
        updates.title = title.trim();
      }
      if (description !== undefined && isAssigner) {
        if (description !== null && (typeof description !== "string" || description.length > 1000)) {
          return res.status(400).json({ error: "Description must be a string (max 1000 characters)" });
        }
        updates.description = description;
      }
      if (priority && isAssigner) updates.priority = priority;

      const updatedTask = await storage.updateModeratorTask(id, updates);
      res.json(updatedTask);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator Meeting routes - scheduled by Head of Moderation or Founder
  app.get("/api/moderator-meetings", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      // Get meetings user is invited to
      const invitedMeetings = await storage.getModeratorMeetings(userId);
      // Also get meetings user scheduled (for HoM/Founder to see their own meetings)
      const scheduledMeetings = await storage.getModeratorMeetingsScheduledBy(userId);
      
      // Combine and deduplicate
      const meetingMap = new Map<string, any>();
      [...invitedMeetings, ...scheduledMeetings].forEach(m => meetingMap.set(m.id, m));
      const allMeetings = Array.from(meetingMap.values()).sort(
        (a, b) => new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime()
      );
      
      res.json(allMeetings);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/moderator-meetings/scheduled-by-me", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const meetings = await storage.getModeratorMeetingsScheduledBy(req.session.userId!);
      res.json(meetings);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/moderator-meetings/:id", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const meeting = await storage.getModeratorMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }
      res.json(meeting);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/moderator-meetings/:id/rsvps", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const meeting = await storage.getModeratorMeeting(req.params.id);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }
      
      const rsvps = await storage.getMeetingRsvps(req.params.id);
      
      // Enrich with user data
      const enrichedRsvps = await Promise.all(
        rsvps.map(async (rsvp) => {
          const user = await storage.getUser(rsvp.moderatorId);
          return { ...rsvp, moderator: user };
        })
      );
      
      res.json(enrichedRsvps);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderator-meetings", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const { title, description, scheduledDate, duration, isTeamMeeting, invitedModeratorIds } = req.body;

      // Validate required fields
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        return res.status(400).json({ error: "Title is required" });
      }
      if (title.length > 200) {
        return res.status(400).json({ error: "Title must be 200 characters or less" });
      }
      if (!scheduledDate) {
        return res.status(400).json({ error: "Scheduled date is required" });
      }

      const parsedDate = new Date(scheduledDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: "Invalid scheduled date" });
      }

      // Validate date is within allowed range (today to 6 months from now)
      const now = new Date();
      const sixMonthsFromNow = new Date();
      sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
      
      if (parsedDate < now) {
        return res.status(400).json({ error: "Meeting date cannot be in the past" });
      }
      if (parsedDate > sixMonthsFromNow) {
        return res.status(400).json({ error: "Meeting date cannot be more than 6 months in the future" });
      }

      // Validate duration if provided
      if (duration !== undefined) {
        const durationNum = Number(duration);
        if (isNaN(durationNum) || durationNum < 15 || durationNum > 480) {
          return res.status(400).json({ error: "Duration must be between 15 and 480 minutes" });
        }
      }

      // If it's a team meeting, get all moderators
      let moderatorsToInvite: string[] = [];
      if (isTeamMeeting) {
        const users = await storage.getUsers();
        moderatorsToInvite = users
          .filter(u => u.role === UserRole.MODERATOR || u.role === UserRole.HEAD_OF_MODERATION)
          .map(u => u.id);
      } else if (invitedModeratorIds && Array.isArray(invitedModeratorIds)) {
        // Validate that all invited users exist and are moderators
        for (const id of invitedModeratorIds) {
          const user = await storage.getUser(id);
          if (!user) {
            return res.status(400).json({ error: `User with ID ${id} not found` });
          }
          if (user.role !== UserRole.MODERATOR && user.role !== UserRole.HEAD_OF_MODERATION) {
            return res.status(400).json({ error: `User ${user.username} is not a moderator` });
          }
        }
        moderatorsToInvite = invitedModeratorIds;
      } else {
        return res.status(400).json({ error: "Must specify invited moderators or mark as team meeting" });
      }

      const meeting = await storage.createModeratorMeeting({
        title: title.trim(),
        description: description?.trim() || null,
        scheduledById: req.session.userId!,
        scheduledDate: parsedDate,
        duration: duration || 60,
        isTeamMeeting: isTeamMeeting || false,
        invitedModeratorIds: moderatorsToInvite,
      });

      // Create RSVPs for all invited moderators
      for (const moderatorId of moderatorsToInvite) {
        await storage.createMeetingRsvp({
          meetingId: meeting.id,
          moderatorId,
          status: MeetingRsvpStatus.PENDING,
        });

        // Notify each moderator
        await storage.createNotification({
          userId: moderatorId,
          type: "meeting_scheduled",
          title: "Meeting Scheduled",
          message: `You have been invited to a meeting: ${title}`,
          relatedId: meeting.id,
          sourceType: "meeting",
          sourceId: meeting.id,
        });
      }

      // Auto-add meeting to shared calendar
      const meetingEnd = new Date(parsedDate.getTime() + (duration || 60) * 60 * 1000);
      await storage.createCalendarEvent({
        title: `Meeting: ${meeting.title}`,
        description: meeting.description || "",
        startTime: parsedDate,
        endTime: meetingEnd,
        createdBy: req.session.userId!,
        type: "event",
      });

      res.status(201).json(meeting);
    } catch (error) {
      console.error("Error creating meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/moderator-meetings/:id/rsvp", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.session.userId!;

      // Validate status
      const validStatuses = [MeetingRsvpStatus.ACCEPTED, MeetingRsvpStatus.DECLINED];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Status must be 'accepted' or 'declined'" });
      }

      const meeting = await storage.getModeratorMeeting(id);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }

      // Check if user is invited
      const isInvited = meeting.isTeamMeeting || meeting.invitedModeratorIds?.includes(userId);
      if (!isInvited) {
        return res.status(403).json({ error: "You are not invited to this meeting" });
      }

      // Find or create RSVP
      let rsvp = await storage.getMeetingRsvpByModerator(id, userId);
      if (!rsvp) {
        rsvp = await storage.createMeetingRsvp({
          meetingId: id,
          moderatorId: userId,
          status,
        });
      } else {
        rsvp = await storage.updateMeetingRsvp(rsvp.id, {
          status,
          respondedAt: new Date(),
        });
      }

      // Notify the scheduler of the response
      const user = await storage.getUser(userId);
      await storage.createNotification({
        userId: meeting.scheduledById,
        type: "system",
        title: "Meeting RSVP",
        message: `${user?.username || "A moderator"} has ${status} the meeting: ${meeting.title}`,
        relatedId: meeting.id,
        sourceType: "system",
        sourceId: meeting.id,
      });

      res.json(rsvp);
    } catch (error) {
      console.error("Error responding to meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/moderator-meetings/:id", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { title, description, scheduledDate, duration } = req.body;

      const meeting = await storage.getModeratorMeeting(id);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }

      // Only the scheduler can update
      if (meeting.scheduledById !== req.session.userId) {
        return res.status(403).json({ error: "Only the meeting scheduler can update it" });
      }

      const updates: any = {};
      if (title !== undefined) {
        if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
          return res.status(400).json({ error: "Title must be a non-empty string (max 200 characters)" });
        }
        updates.title = title.trim();
      }
      if (description !== undefined) {
        updates.description = description?.trim() || null;
      }
      if (scheduledDate !== undefined) {
        const parsedDate = new Date(scheduledDate);
        if (isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: "Invalid scheduled date" });
        }
        updates.scheduledDate = parsedDate;
      }
      if (duration !== undefined) {
        const durationNum = Number(duration);
        if (isNaN(durationNum) || durationNum < 15 || durationNum > 480) {
          return res.status(400).json({ error: "Duration must be between 15 and 480 minutes" });
        }
        updates.duration = durationNum;
      }

      const updatedMeeting = await storage.updateModeratorMeeting(id, updates);
      res.json(updatedMeeting);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Meeting Exemption routes - moderators can request exemption from required meetings
  app.get("/api/meeting-exemptions", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // HoM/Founder can see all pending exemptions, moderators see only their own
      if (user.role === UserRole.HEAD_OF_MODERATION || user.role === UserRole.FOUNDER) {
        const exemptions = await storage.getPendingMeetingExemptions();
        // Enrich with user and meeting data
        const enrichedExemptions = await Promise.all(
          exemptions.map(async (e) => {
            const moderator = await storage.getUser(e.moderatorId);
            const meeting = await storage.getModeratorMeeting(e.meetingId);
            return { ...e, moderator, meeting };
          })
        );
        res.json(enrichedExemptions);
      } else {
        const exemptions = await storage.getMeetingExemptionsByModerator(req.session.userId!);
        const enrichedExemptions = await Promise.all(
          exemptions.map(async (e) => {
            const meeting = await storage.getModeratorMeeting(e.meetingId);
            return { ...e, meeting };
          })
        );
        res.json(enrichedExemptions);
      }
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/meeting-exemptions", requireRole("moderator"), async (req, res) => {
    try {
      const { meetingId, reason } = req.body;
      const userId = req.session.userId!;

      if (!meetingId || !reason) {
        return res.status(400).json({ error: "Meeting ID and reason are required" });
      }

      if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
        return res.status(400).json({ error: "Reason must be between 10 and 500 characters" });
      }

      // Verify meeting exists
      const meeting = await storage.getModeratorMeeting(meetingId);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }

      // Check if user is invited to this meeting
      const isInvited = meeting.isTeamMeeting || meeting.invitedModeratorIds?.includes(userId);
      if (!isInvited) {
        return res.status(403).json({ error: "You are not invited to this meeting" });
      }

      // Check for existing pending exemption
      const existingExemptions = await storage.getMeetingExemptionsByModerator(userId);
      const hasPending = existingExemptions.some(
        e => e.meetingId === meetingId && e.status === "pending"
      );
      if (hasPending) {
        return res.status(400).json({ error: "You already have a pending exemption request for this meeting" });
      }

      const exemption = await storage.createMeetingExemption({
        meetingId,
        moderatorId: userId,
        reason: reason.trim(),
      });

      // Notify HoM/Founder
      const users = await storage.getUsers();
      const admins = users.filter(u => 
        u.role === UserRole.HEAD_OF_MODERATION || u.role === UserRole.FOUNDER
      );
      const requester = await storage.getUser(userId);
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          type: "meeting_exemption_request",
          title: "Meeting Exemption Request",
          message: `${requester?.username || "A moderator"} has requested an exemption from "${meeting.title}"`,
          relatedId: exemption.id,
          sourceType: "exemption",
          sourceId: exemption.id,
        });
      }

      res.status(201).json(exemption);
    } catch (error) {
      console.error("Error creating exemption:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/meeting-exemptions/:id/respond", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const { id } = req.params;
      const { approved, note } = req.body;
      const userId = req.session.userId!;

      if (typeof approved !== "boolean") {
        return res.status(400).json({ error: "Approved must be true or false" });
      }

      const exemption = await storage.getMeetingExemption(id);
      if (!exemption) {
        return res.status(404).json({ error: "Exemption request not found" });
      }

      if (exemption.status !== "pending") {
        return res.status(400).json({ error: "This exemption request has already been reviewed" });
      }

      const updatedExemption = await storage.updateMeetingExemption(id, {
        status: approved ? "approved" : "denied",
        reviewedById: userId,
        reviewNote: note?.trim() || null,
        reviewedAt: new Date(),
      });

      // If approved, update RSVP to declined (exempted from attending)
      if (approved) {
        const rsvp = await storage.getMeetingRsvpByModerator(exemption.meetingId, exemption.moderatorId);
        if (rsvp) {
          await storage.updateMeetingRsvp(rsvp.id, { status: "declined", respondedAt: new Date() });
        }
      }

      // Notify the moderator
      const meeting = await storage.getModeratorMeeting(exemption.meetingId);
      await storage.createNotification({
        userId: exemption.moderatorId,
        type: "system",
        title: approved ? "Exemption Approved" : "Exemption Denied",
        message: approved
          ? `Your exemption request for "${meeting?.title || "a meeting"}" has been approved`
          : `Your exemption request for "${meeting?.title || "a meeting"}" has been denied${note ? `: ${note}` : ""}`,
        relatedId: exemption.id,
        sourceType: "system",
        sourceId: exemption.id,
      });

      res.json(updatedExemption);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Founder-only routes for managing Head of Moderation
  app.get("/api/admin/heads-of-moderation", requireRole("founder"), async (req, res) => {
    try {
      const users = await storage.getUsers();
      const headsOfModeration = users.filter(u => u.role === UserRole.HEAD_OF_MODERATION);
      res.json(headsOfModeration);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/assign-head-of-moderation/:userId", requireRole("founder"), async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Get current heads of moderation count
      const users = await storage.getUsers();
      const headsOfModeration = users.filter(u => u.role === UserRole.HEAD_OF_MODERATION);
      
      if (headsOfModeration.length >= 3) {
        return res.status(400).json({ 
          error: "Maximum of 3 Heads of Moderation allowed. Remove one before assigning another." 
        });
      }
      
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      if (targetUser.role === UserRole.FOUNDER) {
        return res.status(400).json({ error: "Cannot change the Founder's role" });
      }
      
      if (targetUser.role === UserRole.HEAD_OF_MODERATION) {
        return res.status(400).json({ error: "User is already a Head of Moderation" });
      }
      
      // Must be at least a moderator to be promoted
      if (targetUser.role !== UserRole.MODERATOR) {
        return res.status(400).json({ error: "Only moderators can be promoted to Head of Moderation" });
      }
      
      await storage.updateUser(userId, { role: UserRole.HEAD_OF_MODERATION });
      
      // Notify the user
      await storage.createNotification({
        userId,
        type: "role_upgrade",
        title: "Promoted to Head of Moderation",
        message: "Congratulations! You have been promoted to Head of Moderation by the Founder.",
        relatedId: userId,
        sourceType: "user",
        sourceId: userId,
        redirectUrl: "/profile",
      });
      
      const updatedUser = await storage.getUser(userId);
      res.json(updatedUser);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/remove-head-of-moderation/:userId", requireRole("founder"), async (req, res) => {
    try {
      const { userId } = req.params;
      
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      if (targetUser.role !== UserRole.HEAD_OF_MODERATION) {
        return res.status(400).json({ error: "User is not a Head of Moderation" });
      }
      
      // Demote back to moderator
      await storage.updateUser(userId, { role: UserRole.MODERATOR });
      
      // Notify the user
      await storage.createNotification({
        userId,
        type: "role_upgrade",
        title: "Role Changed",
        message: "Your role has been changed from Head of Moderation to Moderator by the Founder.",
        relatedId: userId,
        sourceType: "user",
        sourceId: userId,
        redirectUrl: "/profile",
      });
      
      const updatedUser = await storage.getUser(userId);
      res.json(updatedUser);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all moderators (for Founder and Head of Moderation to manage team)
  app.get("/api/admin/moderators", requireRole("head_of_moderation", "founder"), async (req, res) => {
    try {
      const users = await storage.getUsers();
      const moderators = users.filter(u => 
        u.role === UserRole.MODERATOR || u.role === UserRole.HEAD_OF_MODERATION
      );
      res.json(moderators);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ PUBLIC PROFILE API ============

  // Helper function to calculate user status
  async function calculateUserStatus(user: any) {
    const now = new Date();
    const lastActive = user.lastActive ? new Date(user.lastActive) : new Date();
    const timeSinceActive = now.getTime() - lastActive.getTime();
    const fiveMinutes = 5 * 60 * 1000; // 5 minutes in ms

    // Online status (green dot): active within the last 5 minutes (app/tab open)
    const isOnline = timeSinceActive < fiveMinutes;
    const onlineStatus = isOnline ? "online" : "offline";

    // Non-freelancers only carry presence (online/offline)
    if (user.role !== "freelancer") {
      return {
        onlineStatus,
        workStatus: null,
        displayStatus: isOnline ? "Online" : "Offline"
      };
    }

    // Freelancer work status: Active within set working hours, Inactive outside.
    let outsideWorkingHours = false;
    const workingHours = user.workingHours as any;
    if (workingHours && Object.keys(workingHours).length > 0) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const currentDay = dayNames[now.getDay()];
      const daySchedule = workingHours[currentDay];

      if (daySchedule && daySchedule.start && daySchedule.end) {
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const [startHour, startMin] = daySchedule.start.split(":").map(Number);
        const [endHour, endMin] = daySchedule.end.split(":").map(Number);
        const startTime = startHour * 60 + startMin;
        const endTime = endHour * 60 + endMin;
        outsideWorkingHours = currentTime < startTime || currentTime > endTime;
      } else {
        // No hours configured for this day = off
        outsideWorkingHours = true;
      }
    }

    // On approved PTO also counts as inactive
    const ptoRequests = await storage.getPTORequests(user.id);
    const onPTO = ptoRequests.some(pto => {
      if (pto.status !== "approved") return false;
      const startDate = new Date(pto.startDate);
      const endDate = new Date(pto.endDate);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      return now >= startDate && now <= endDate;
    });

    const workStatus = onPTO || outsideWorkingHours ? "inactive" : "active";

    return {
      onlineStatus,
      workStatus,
      displayStatus: isOnline ? "Online" : "Offline"
    };
  }

  // Get public profile of any user
  app.get("/api/users/:id/profile", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const requesterId = req.session.userId!;
      const requester = await storage.getUser(requesterId);

      // Check showOnlineStatus preference before revealing status.
      // The user's choice wins for everyone — no requester bypass.
      const profilePrefs = await storage.getUserPreferences(user.id);
      const showOnline = profilePrefs?.showOnlineStatus !== false;

      let status;
      if (showOnline) {
        status = await calculateUserStatus(user);
      } else {
        status = { onlineStatus: "offline", workStatus: null, displayStatus: "Offline" };
      }

      // Determine email visibility
      const emailVisibility = profilePrefs?.emailVisibility || "none";
      let visibleEmail: string | null = null;
      if (user.email && emailVisibility !== "none") {
        if (emailVisibility === "all") {
          visibleEmail = user.email;
        } else if (emailVisibility === "friends") {
          const areFriends = await storage.areFriends(requesterId, user.id);
          if (areFriends) visibleEmail = user.email;
        } else if (emailVisibility === "associates") {
          // Associates = friends OR past/present job collaborators
          const areFriends = await storage.areFriends(requesterId, user.id);
          const areConnected = await storage.areUsersConnected(requesterId, user.id);
          if (areFriends || areConnected) visibleEmail = user.email;
        }
      }

      // Friends and followers counts
      const friends = await storage.getFriends(user.id);
      const followerCount = await storage.getFollowerCount(user.id);
      const followingCount = await storage.getFollowingCount(user.id);

      // Is requester following this user?
      const isFollowing = requesterId !== user.id ? await storage.isFollowing(requesterId, user.id) : false;
      // Is requester blocked by or has blocked this user?
      const hasBlocked = requesterId !== user.id ? await storage.isBlocked(requesterId, user.id) : false;

      // Friend request status between requester and profile user
      const friendRequest = requesterId !== user.id ? await storage.getFriendRequestBetweenUsers(requesterId, user.id) : null;
      const areFriends = requesterId !== user.id ? await storage.areFriends(requesterId, user.id) : false;

      // Return public profile info with safe defaults
      const ratingValue = parseFloat(user.rating?.toString() || "0");
      const safeRating = isNaN(ratingValue) ? 0 : ratingValue;
      
      const publicProfile: any = {
        id: user.id,
        userId: user.userId,
        username: user.username,
        avatar: user.avatar || null,
        role: user.role,
        level: user.level || 1,
        rating: safeRating > 0 ? safeRating.toFixed(1) : "N/A",
        ratingCount: user.totalRatings || 0,
        completedJobs: user.completedJobs || 0,
        completionPercentage: user.completionPercentage || "0",
        totalJobs: user.totalJobs || 0,
        createdAt: user.createdAt,
        specialization: user.specialization || null,
        portfolio: user.portfolio || null,
        workingHours: user.workingHours || null,
        bio: user.bio || null,
        status: status,
        email: visibleEmail,
        friendCount: friends.length,
        followerCount,
        followingCount,
        isFollowing,
        hasBlocked,
        areFriends,
        friendRequestStatus: friendRequest ? friendRequest.status : null,
        friendRequestId: friendRequest ? friendRequest.id : null,
        friendRequestFromMe: friendRequest ? friendRequest.fromUserId === requesterId : null,
      };

      // For freelancers, include their full completed job history
      if (user.role === "freelancer" || user.role === "moderator") {
        const jobs = await storage.getJobs();
        const completedJobsList = jobs.filter(
          j => j.freelancerId === user.id && j.status === "completed"
        ).map(j => ({
          id: j.id,
          title: j.title,
          category: j.category,
          completedAt: j.updatedAt,
        }));
        publicProfile.completedJobHistory = completedJobsList;
      }

      // Reviews: customers reviewing a freelancer, or freelancers reviewing a customer.
      // Cap at the most recent 50 so heavy users don't trigger unbounded enrichment work.
      if (user.role === "freelancer") {
        const ratings = (await storage.getRatingsByFreelancer(user.id)).slice(0, 50);
        publicProfile.reviews = await Promise.all(ratings.map(async (r) => {
          const reviewer = await storage.getUser(r.customerId);
          const job = await storage.getJob(r.jobId);
          return {
            id: r.id,
            score: r.score,
            review: r.review,
            createdAt: r.createdAt,
            reviewerId: r.customerId,
            reviewerUsername: reviewer?.username || "Customer",
            reviewerAvatar: reviewer?.avatar || null,
            jobTitle: job?.title || null,
          };
        }));
      } else if (user.role === "customer") {
        const ratings = (await storage.getCustomerRatings(user.id)).slice(0, 50);
        publicProfile.reviews = await Promise.all(ratings.map(async (r) => {
          const reviewer = await storage.getUser(r.freelancerId);
          const job = await storage.getJob(r.jobId);
          return {
            id: r.id,
            score: r.score,
            review: r.review,
            createdAt: r.createdAt,
            reviewerId: r.freelancerId,
            reviewerUsername: reviewer?.username || "Freelancer",
            reviewerAvatar: reviewer?.avatar || null,
            jobTitle: job?.title || null,
          };
        }));
      }

      res.json(publicProfile);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get customer statistics for job details page
  app.get("/api/users/:id/customer-stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get all jobs posted by this customer
      const jobs = await storage.getJobs();
      const customerJobs = jobs.filter(j => j.customerId === req.params.id);
      
      const totalPostedJobs = customerJobs.length;
      const completedJobs = customerJobs.filter(j => 
        j.status === "completed" || j.status === "COMPLETED"
      ).length;
      const cancelledJobs = customerJobs.filter(j => 
        j.status === "cancelled" || j.status === "CANCELLED"
      ).length;
      const inProgressJobs = customerJobs.filter(j => 
        ["in_progress", "IN_PROGRESS", "awaiting_customer", "AWAITING_CUSTOMER", "submitted", "SUBMITTED"].includes(j.status)
      ).length;
      
      // Calculate credibility score (0-100)
      // Credibility starts at 100% and decreases based on cancellation rate
      // No cancellations = 100% credibility (trustworthy customer)
      let credibility = 100;
      if (totalPostedJobs > 0 && cancelledJobs > 0) {
        // Only reduce credibility if there are cancellations
        const cancellationRate = (cancelledJobs / totalPostedJobs) * 100;
        // Each cancellation reduces credibility significantly
        credibility = Math.max(0, 100 - (cancellationRate * 2));
      }
      // New customers or customers with no cancellations get 100% credibility

      res.json({
        totalPostedJobs,
        completedJobs,
        cancelledJobs,
        inProgressJobs,
        credibility: Math.round(credibility),
        memberSince: user.createdAt,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get freelancer recommendations
  app.get("/api/freelancers/recommendations", requireAuth, async (req, res) => {
    try {
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const users = await storage.getUsers();
      
      // Get customer's blacklist if they are a customer
      const customerBlacklist = currentUser.role === "customer" 
        ? (currentUser.blacklistedFreelancers || []) 
        : [];
      
      const freelancers = users.filter(u => 
        u.role === "freelancer" && 
        u.id !== req.session.userId &&
        !customerBlacklist.includes(u.id) // Exclude blacklisted freelancers
      );

      // Score freelancers based on various factors
      const scoredFreelancers = freelancers.map(f => {
        let score = 0;
        
        // Rating bonus (up to 50 points) - safely parse rating
        const ratingValue = parseFloat(f.rating?.toString() || "0");
        const safeRating = isNaN(ratingValue) ? 0 : ratingValue;
        score += safeRating * 10;
        
        // Level bonus (up to 50 points)
        const level = f.level || 1;
        score += level * 5;
        
        // Completed jobs bonus (up to 30 points)
        const completedJobs = f.completedJobs || 0;
        score += Math.min(completedJobs * 2, 30);
        
        // Rating count bonus (more reviews = more trustworthy)
        const totalRatings = f.totalRatings || 0;
        score += Math.min(totalRatings * 2, 20);

        return {
          id: f.id,
          userId: f.userId,
          username: f.username,
          avatar: f.avatar,
          level: level,
          rating: safeRating > 0 ? safeRating.toFixed(1) : "N/A",
          ratingCount: totalRatings,
          completedJobs: completedJobs,
          specialization: f.specialization || null,
          score,
        };
      });

      // Sort by score and return top 10
      scoredFreelancers.sort((a, b) => b.score - a.score);
      res.json(scoredFreelancers.slice(0, 10));
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ JOB RECOMMENDATIONS API ============

  // Create a job recommendation (Freelancer A recommends Freelancer B for a job)
  app.post("/api/recommendations", requireAuth, async (req, res) => {
    try {
      const recommender = await storage.getUser(req.session.userId!);
      if (!recommender) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Only freelancers can recommend other freelancers
      if (recommender.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can recommend other freelancers" });
      }

      const { recommendedFreelancerId, jobId, customerMessage, freelancerMessage } = req.body;

      if (!recommendedFreelancerId || !jobId) {
        return res.status(400).json({ error: "Freelancer ID and Job ID are required" });
      }

      // Verify the recommended freelancer exists and is a freelancer
      const recommendedFreelancer = await storage.getUser(recommendedFreelancerId);
      if (!recommendedFreelancer || recommendedFreelancer.role !== "freelancer") {
        return res.status(404).json({ error: "Freelancer not found" });
      }

      // Can't recommend yourself
      if (recommendedFreelancerId === recommender.id) {
        return res.status(400).json({ error: "You cannot recommend yourself" });
      }

      // Verify the job exists and is in a working state
      const job = await storage.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Job must be in a working state (claimed, in_progress, or awaiting_customer)
      const validStatuses = ["claimed", "in_progress", "awaiting_customer"];
      if (!validStatuses.includes(job.status)) {
        return res.status(400).json({ error: "This job is not available for recommendations" });
      }

      // Verify the recommender is assigned to this job
      const freelancerAssignments = await storage.getJobFreelancersByFreelancer(recommender.id);
      const isAssignedViaTable = freelancerAssignments.some(jf => jf.jobId === jobId);
      if (job.freelancerId !== recommender.id && !isAssignedViaTable) {
        return res.status(403).json({ error: "You can only recommend for jobs you are working on" });
      }

      // Check if this recommendation already exists
      const existingRecs = await storage.getJobRecommendationsByRecommender(recommender.id);
      const alreadyRecommended = existingRecs.find(
        r => r.recommendedFreelancerId === recommendedFreelancerId && 
             r.jobId === jobId && 
             r.status === "pending"
      );
      if (alreadyRecommended) {
        return res.status(400).json({ error: "You have already recommended this freelancer for this job" });
      }

      // Create the recommendation
      const recommendation = await storage.createJobRecommendation({
        recommenderId: recommender.id,
        recommendedFreelancerId,
        jobId,
        customerId: job.customerId,
        recommenderMessage: customerMessage || null,
        freelancerMessage: freelancerMessage || null,
      });

      // Notify the customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_recommendation",
        title: "Freelancer Recommendation",
        message: `${recommender.username} recommends ${recommendedFreelancer.username} for your job: ${job.title}`,
        relatedId: recommendation.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true, recommendation });
    } catch (error) {
      console.error("Error creating recommendation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get recommendations for customer (incoming recommendations)
  app.get("/api/recommendations/customer", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (user.role !== "customer") {
        return res.status(403).json({ error: "Only customers can view incoming recommendations" });
      }

      const recommendations = await storage.getJobRecommendationsByCustomer(user.id);

      // Enrich with user and job data
      const enriched = await Promise.all(recommendations.map(async (rec) => {
        const recommender = await storage.getUser(rec.recommenderId);
        const recommendedFreelancer = await storage.getUser(rec.recommendedFreelancerId);
        const job = await storage.getJob(rec.jobId);
        return {
          ...rec,
          recommender: recommender ? { 
            id: recommender.id, 
            username: recommender.username, 
            avatar: recommender.avatar,
            level: recommender.level,
            rating: recommender.rating
          } : null,
          recommendedFreelancer: recommendedFreelancer ? {
            id: recommendedFreelancer.id,
            username: recommendedFreelancer.username,
            avatar: recommendedFreelancer.avatar,
            level: recommendedFreelancer.level || 1,
            rating: recommendedFreelancer.rating,
            ratingCount: recommendedFreelancer.totalRatings || 0,
            completedJobs: recommendedFreelancer.completedJobs || 0,
            specialization: recommendedFreelancer.specialization,
          } : null,
          job: job ? { id: job.id, title: job.title, budget: job.budget, category: job.category } : null,
        };
      }));

      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get job invitations for freelancer (recommendations that were accepted by customer)
  app.get("/api/recommendations/invitations", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can view job invitations" });
      }

      const recommendations = await storage.getJobRecommendationsForFreelancer(user.id);
      const invitations = recommendations.filter(r => r.status === "customer_accepted");

      // Enrich with user and job data, including team info
      const enriched = await Promise.all(invitations.map(async (rec) => {
        const recommender = await storage.getUser(rec.recommenderId);
        const customer = await storage.getUser(rec.customerId);
        const job = await storage.getJob(rec.jobId);
        
        // Get current team members for this job
        let teamMembers: Array<{id: string; username: string; avatar: string | null; level: number}> = [];
        if (job) {
          // Check main freelancer assignment
          if (job.freelancerId) {
            const mainFreelancer = await storage.getUser(job.freelancerId);
            if (mainFreelancer) {
              teamMembers.push({
                id: mainFreelancer.id,
                username: mainFreelancer.username,
                avatar: mainFreelancer.avatar,
                level: mainFreelancer.level || 1,
              });
            }
          }
          // Check jobFreelancers table for multi-freelancer jobs
          const jobFreelancers = await storage.getJobFreelancers(job.id);
          for (const jf of jobFreelancers) {
            const fl = await storage.getUser(jf.freelancerId);
            if (fl && !teamMembers.find(tm => tm.id === fl.id)) {
              teamMembers.push({
                id: fl.id,
                username: fl.username,
                avatar: fl.avatar,
                level: fl.level || 1,
              });
            }
          }
        }
        
        // Calculate estimated split (budget divided by current team size + 1 for the invited person)
        // Then apply level-based payout percentage
        const currentTeamSize = teamMembers.length;
        const estimatedSplitCount = currentTeamSize + 1;
        const jobBudget = job ? parseFloat(job.budget) : 0;
        const baseShare = jobBudget / estimatedSplitCount;
        
        // Apply the invited freelancer's level percentage
        const invitedFreelancer = await storage.getUser(rec.recommendedFreelancerId);
        const invitedLevel = invitedFreelancer?.level || 1;
        const levelPayout = getLevelPayout(invitedLevel);
        const estimatedShare = baseShare * levelPayout;
        
        return {
          ...rec,
          recommender: recommender ? { 
            id: recommender.id, 
            username: recommender.username, 
            avatar: recommender.avatar 
          } : null,
          customer: customer ? {
            id: customer.id,
            username: customer.username,
            avatar: customer.avatar,
          } : null,
          job: job ? { 
            id: job.id, 
            title: job.title, 
            description: job.description,
            budget: job.budget, 
            category: job.category,
            deadline: job.deadline
          } : null,
          teamMembers,
          currentTeamSize,
          estimatedShare: estimatedShare.toFixed(2),
        };
      }));

      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer accepts/declines a recommendation
  app.post("/api/recommendations/:id/respond", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const recommendation = await storage.getJobRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Recommendation not found" });
      }

      // Only the customer of the job can respond
      if (recommendation.customerId !== user.id) {
        return res.status(403).json({ error: "You are not authorized to respond to this recommendation" });
      }

      if (recommendation.status !== "pending") {
        return res.status(400).json({ error: "This recommendation has already been processed" });
      }

      const { accept, note } = req.body;

      if (accept) {
        // Customer accepts - send invitation to freelancer
        await storage.updateJobRecommendation(recommendation.id, {
          status: "customer_accepted",
          customerNote: note || null,
        });

        // Notify the freelancer about the invitation
        const job = await storage.getJob(recommendation.jobId);
        const recommender = await storage.getUser(recommendation.recommenderId);
        await storage.createNotification({
          userId: recommendation.recommendedFreelancerId,
          type: "job_invitation",
          title: "Job Invitation",
          message: `${user.username} has invited you to work on: ${job?.title || "a job"} (recommended by ${recommender?.username || "a friend"})`,
          relatedId: recommendation.id,
          sourceType: "job",
          sourceId: job?.id || null,
        });

        // Notify the recommender that their recommendation was accepted
        await storage.createNotification({
          userId: recommendation.recommenderId,
          type: "recommendation_accepted",
          title: "Recommendation Accepted",
          message: `Your recommendation was accepted! ${user.username} has invited your friend to work on: ${job?.title || "a job"}`,
          relatedId: recommendation.id,
          sourceType: "job",
          sourceId: job?.id || null,
        });

        res.json({ success: true, message: "Invitation sent to freelancer" });
      } else {
        // Customer declines
        await storage.updateJobRecommendation(recommendation.id, {
          status: "customer_declined",
          customerNote: note || null,
        });

        // Notify the recommender
        const job = await storage.getJob(recommendation.jobId);
        await storage.createNotification({
          userId: recommendation.recommenderId,
          type: "recommendation_declined",
          title: "Recommendation Declined",
          message: `Your recommendation for ${job?.title || "a job"} was declined by the customer`,
          relatedId: recommendation.id,
          sourceType: "job",
          sourceId: job?.id || null,
        });

        res.json({ success: true, message: "Recommendation declined" });
      }
    } catch (error) {
      console.error("Error responding to recommendation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Freelancer accepts/declines a job invitation
  app.post("/api/recommendations/:id/invitation-respond", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const recommendation = await storage.getJobRecommendation(req.params.id);
      if (!recommendation) {
        return res.status(404).json({ error: "Invitation not found" });
      }

      // Only the recommended freelancer can respond
      if (recommendation.recommendedFreelancerId !== user.id) {
        return res.status(403).json({ error: "You are not authorized to respond to this invitation" });
      }

      if (recommendation.status !== "customer_accepted") {
        return res.status(400).json({ error: "This invitation is no longer valid" });
      }

      const { accept } = req.body;
      const job = await storage.getJob(recommendation.jobId);
      const recommender = await storage.getUser(recommendation.recommenderId);
      const customer = await storage.getUser(recommendation.customerId);

      if (accept) {
        // Check if freelancer already has an active job (as primary, team member, collaborator, or via jobFreelancers)
        const allJobs = await storage.getJobs({});
        const activeStatuses = ["in_progress", "claimed", "awaiting_customer", "submitted"];
        
        const assignedActiveJobs = allJobs.filter(j => {
          if (!activeStatuses.includes(j.status)) return false;
          if (j.freelancerId === user.id) return true;
          if (j.teamMembers?.includes(user.id)) return true;
          if (j.collaborators?.includes(user.id)) return true;
          return false;
        });

        if (assignedActiveJobs.length > 0) {
          return res.status(400).json({ error: "You are already assigned to an active job. Complete it before accepting new invitations." });
        }

        // Also check jobFreelancers table for multi-freelancer assignments
        const jobFreelancerAssignments = await storage.getJobFreelancersByFreelancer(user.id);
        for (const jf of jobFreelancerAssignments) {
          const assignedJob = await storage.getJob(jf.jobId);
          if (assignedJob && activeStatuses.includes(assignedJob.status)) {
            return res.status(400).json({ error: "You are already assigned to an active job. Complete it before accepting new invitations." });
          }
        }

        // Check if job is still available - allow joining for active, claimed, or in_progress jobs
        const acceptableStatuses = ["active", "claimed", "in_progress"];
        if (!job || !acceptableStatuses.includes(job.status)) {
          return res.status(400).json({ error: "This job is no longer available" });
        }

        // Check if already assigned to this job
        const existingAssignments = await storage.getJobFreelancers(job.id);
        const alreadyAssigned = job.freelancerId === user.id || 
                               existingAssignments.some(jf => jf.freelancerId === user.id);
        if (alreadyAssigned) {
          return res.status(400).json({ error: "You are already assigned to this job" });
        }

        // Check 5-person team limit
        const currentTeamSize = job.freelancerId ? 1 + existingAssignments.length : existingAssignments.length;
        if (currentTeamSize >= 5) {
          return res.status(400).json({ error: "This job already has the maximum of 5 team members" });
        }

        // For multi-freelancer jobs, add to jobFreelancers table
        // If job has no freelancer yet, assign directly
        if (!job.freelancerId) {
          await storage.updateJob(job.id, {
            freelancerId: user.id,
            status: "claimed",
          });
        } else {
          // Add as additional team member
          // Calculate equal share among existing team + new member
          const existingFreelancerCount = existingAssignments.length + 1; // +1 for main freelancer
          const newTeamSize = existingFreelancerCount + 1;
          const sharePerMember = (parseFloat(job.budget) / newTeamSize).toFixed(2);
          
          await storage.createJobFreelancer({
            jobId: job.id,
            freelancerId: user.id,
            shareAmount: sharePerMember,
            levelAtTime: user.level || 1,
            status: "active",
          });
        }

        await storage.updateJobRecommendation(recommendation.id, {
          status: "invitation_accepted",
        });

        // Cancel other pending requests for this job
        const pendingRequests = await storage.getJobRequestsByJob(job.id);
        for (const request of pendingRequests) {
          if (request.status === "pending") {
            await storage.updateJobRequest(request.id, { status: "cancelled" });
          }
        }

        // Notify customer
        await storage.createNotification({
          userId: recommendation.customerId,
          type: "invitation_accepted",
          title: "Invitation Accepted",
          message: `${user.username} has accepted your job invitation for: ${job.title}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });

        // Notify recommender
        await storage.createNotification({
          userId: recommendation.recommenderId,
          type: "recommendation_success",
          title: "Recommendation Successful",
          message: `Your friend ${user.username} accepted the job: ${job.title}`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });

        res.json({ success: true, message: "You have been assigned to the job" });
      } else {
        // Freelancer declines
        await storage.updateJobRecommendation(recommendation.id, {
          status: "invitation_declined",
        });

        // Notify customer
        await storage.createNotification({
          userId: recommendation.customerId,
          type: "invitation_declined",
          title: "Invitation Declined",
          message: `${user.username} has declined your job invitation for: ${job?.title || "a job"}`,
          relatedId: recommendation.id,
          sourceType: "job",
          sourceId: job?.id || null,
        });

        // Notify recommender
        await storage.createNotification({
          userId: recommendation.recommenderId,
          type: "invitation_declined",
          title: "Invitation Declined",
          message: `Your friend ${user.username} declined the job invitation for: ${job?.title || "a job"}`,
          relatedId: recommendation.id,
          sourceType: "job",
          sourceId: job?.id || null,
        });

        res.json({ success: true, message: "Invitation declined" });
      }
    } catch (error) {
      console.error("Error responding to invitation:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get jobs that a freelancer can recommend others for (only jobs where the freelancer is assigned)
  app.get("/api/recommendations/available-jobs", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can view available jobs for recommendation" });
      }

      // Get all jobs and filter for ones where this freelancer is assigned
      const allJobs = await storage.getJobs();
      const freelancerJobAssignments = await storage.getJobFreelancersByFreelancer(user.id);
      const assignedJobIds = new Set(freelancerJobAssignments.map(jf => jf.jobId));
      
      // Filter for jobs where freelancer is assigned (via freelancerId or jobFreelancers table)
      // and job is in a working state (claimed, in_progress, awaiting_customer)
      const myJobs = allJobs.filter(j => 
        (j.freelancerId === user.id || assignedJobIds.has(j.id)) &&
        (j.status === "claimed" || j.status === "in_progress" || j.status === "awaiting_customer")
      );

      // Return basic job info
      const jobsWithCustomerInfo = await Promise.all(myJobs.map(async (job) => {
        const customer = await storage.getUser(job.customerId);
        return {
          id: job.id,
          title: job.title,
          budget: job.budget,
          category: job.category,
          customer: customer ? {
            id: customer.id,
            username: customer.username,
            avatar: customer.avatar,
          } : null,
        };
      }));

      res.json(jobsWithCustomerInfo);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ DIRECT MESSAGES API ============

  // Find user by User ID (globally unique)
  app.get("/api/users/find", requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.query.userId as string);

      if (isNaN(userId)) {
        return res.status(400).json({ error: "User ID is required" });
      }

      const user = await storage.getUserByUserId(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found with this ID" });
      }

      // Don't let users message themselves
      if (user.id === req.session.userId) {
        return res.status(400).json({ error: "You cannot message yourself" });
      }

      res.json({
        id: user.id,
        userId: user.userId,
        username: user.username,
        avatar: user.avatar,
        role: user.role,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users/by-userid/:userId", requireAuth, async (req, res) => {
    try {
      const numericId = parseInt(req.params.userId);
      if (isNaN(numericId) || numericId < 1) {
        return res.status(400).json({ error: "Invalid user ID" });
      }
      const user = await storage.getUserByUserId(numericId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({
        id: user.id,
        userId: user.userId,
        username: user.username,
        avatar: user.avatar,
        role: user.role,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all conversations for current user
  app.get("/api/messages/conversations", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const hidden = new Set(await storage.getHiddenConversationPartners(userId));
      const conversations = (await storage.getConversations(userId)).filter(
        (conv) => !hidden.has(conv.partnerId)
      );

      // Enrich with partner details
      const enrichedConversations = await Promise.all(
        conversations.map(async (conv) => {
          const partner = await storage.getUser(conv.partnerId);
          const isBlocked = await storage.isBlocked(userId, conv.partnerId);
          return {
            ...conv,
            isBlocked,
            partner: partner ? {
              id: partner.id,
              userId: partner.userId,
              username: partner.username,
              avatar: partner.avatar,
              role: partner.role,
            } : null,
          };
        })
      );

      res.json(enrichedConversations);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove (hide) a DM conversation from the current user's Messages list.
  // This does NOT delete the messages — the other person keeps their copy, and
  // if they message again the conversation naturally reappears.
  app.delete("/api/messages/conversations/:partnerId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      await storage.hideConversation(userId, req.params.partnerId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get messages between current user and another user
  app.get("/api/messages/:partnerId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const partnerId = req.params.partnerId;

      const messages = await storage.getDirectMessages(userId, partnerId);

      // Mark messages as read
      await storage.markDirectMessagesAsRead(partnerId, userId);

      // Enrich with sender info
      const enrichedMessages = await Promise.all(
        messages.map(async (msg) => {
          const sender = await storage.getUser(msg.senderId);
          return {
            ...msg,
            sender: sender ? {
              id: sender.id,
              userId: sender.userId,
              username: sender.username,
              avatar: sender.avatar,
              role: sender.role,
            } : null,
          };
        })
      );

      res.json(enrichedMessages);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Send a direct message
  app.post("/api/messages/:receiverId", requireAuth, async (req, res) => {
    try {
      const senderId = req.session.userId!;
      const receiverId = req.params.receiverId;
      const { message } = req.body;

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "Message is required" });
      }

      // Verify receiver exists
      const receiver = await storage.getUser(receiverId);
      if (!receiver) {
        return res.status(404).json({ error: "Recipient not found" });
      }

      // Check if sender is blocked by receiver
      const isBlockedByReceiver = await storage.isBlocked(receiverId, senderId);
      if (isBlockedByReceiver) {
        return res.status(403).json({ error: `You can't message ${receiver.username} because they have blocked you.` });
      }

      // Check receiver's privacy settings
      // Moderators and above can bypass all DM restrictions
      const senderUser = await storage.getUser(senderId);
      const bypassRoles = ["moderator", "head_of_moderation", "founder", "staff"];
      const senderCanBypass = senderUser && bypassRoles.includes(senderUser.role);

      if (!senderCanBypass) {
        const receiverPrefs = await storage.getUserPreferences(receiverId);
        // allowDirectMessages is a tiered text: "everyone"|"friends_and_associates"|"friends"|"associates"|"none"
        // Fallback to legacy boolean handling if value is boolean true/false
        const dmSetting = (receiverPrefs?.allowDirectMessages as string) ?? "everyone";

        if (dmSetting === "none") {
          return res.status(403).json({ error: "This user is not accepting direct messages." });
        }

        if (dmSetting !== "everyone") {
          const isFriend = await storage.areFriends(senderId, receiverId);
          const isConnected = await storage.areUsersConnected(senderId, receiverId);

          // "associates" = share a job or have prior messages (areUsersConnected includes friends,
          //  but we treat it as "connected" which covers all associate-type relationships)
          // For "associates" we check isConnected (which includes jobs + prior messages + friends)
          // For "friends" we check only isFriend
          // For "friends_and_associates" we check isFriend OR isConnected (same as isConnected)

          let allowed = false;
          if (dmSetting === "friends") {
            allowed = isFriend;
          } else if (dmSetting === "associates") {
            // associates = connected through job or prior messages (not requiring friendship)
            // areUsersConnected already includes jobs + prior messages + friends
            allowed = isConnected;
          } else if (dmSetting === "friends_and_associates") {
            allowed = isFriend || isConnected;
          }

          if (!allowed) {
            if (dmSetting === "friends") {
              return res.status(403).json({ error: "This user only accepts messages from friends." });
            } else if (dmSetting === "associates") {
              return res.status(403).json({ error: "This user only accepts messages from people they've worked with, messaged before, or shared a group chat with." });
            } else {
              return res.status(403).json({ error: "This user's messaging settings do not allow you to contact them." });
            }
          }
        }
      }

      // Content filtering
      const contentResult = filterContent(message);
      if (!contentResult.isClean || isSpamLike(message)) {
        return res.status(400).json({ error: "Message contains inappropriate content" });
      }

      // Spam filter: a sender is "known" (not spam) when they have exchanged
      // messages, shared a job, are friends, or have both spoken in a shared
      // group chat with the receiver (areUsersConnected covers all of these —
      // merely sharing a group chat without speaking does not count).
      const sender = await storage.getUser(senderId);
      const isKnownSender = await storage.areUsersConnected(senderId, receiverId);

      const directMessage = await storage.createDirectMessage({
        senderId,
        receiverId,
        message: sanitizeText(message.trim()),
      });

      // A new message makes a removed conversation reappear for the receiver.
      await storage.unhideConversation(receiverId, senderId);

      // Create notification for receiver. When the spam filter is on and the
      // sender is unknown, the notification is created pre-read so it never
      // pings the receiver or counts toward their unread badge — it silently
      // files itself in the Spam tab instead. The master "Enable Notifications"
      // switch is a delivery preference handled client-side (badge suppression
      // + sound), not an inbox filter, so the notification is always created.
      const receiverPrefs = await storage.getUserPreferences(receiverId);
      const spamFilterOn = receiverPrefs?.spamFilterEnabled ?? false;
      const isSpamNotification = spamFilterOn && !isKnownSender;
      await storage.createNotification({
        userId: receiverId,
        type: isKnownSender ? "direct_message" : "direct_message_unknown",
        title: "New Message",
        message: `${sender?.username || "Someone"} sent you a message`,
        relatedId: senderId,
        sourceType: "user",
        sourceId: senderId,
        read: isSpamNotification,
      });

      res.json({
        ...directMessage,
        sender: sender ? {
          id: sender.id,
          userId: sender.userId,
          username: sender.username,
          avatar: sender.avatar,
          role: sender.role,
        } : null,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ TEAM ROOM API ============
  
  // Get team room messages (moderators only)
  app.get("/api/team-room/messages", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const messages = await storage.getTeamRoomMessages(limit);
      
      // Attach sender info to each message
      const messagesWithSenders = await Promise.all(
        messages.map(async (msg) => {
          const sender = await storage.getUser(msg.senderId);
          return {
            ...msg,
            sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, role: sender.role } : null
          };
        })
      );
      
      res.json(messagesWithSenders);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Send team room message
  app.post("/api/team-room/messages", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const result = insertTeamRoomMessageSchema.safeParse({ ...req.body, senderId: userId });
      
      if (!result.success) {
        return res.status(400).json({ error: result.error.issues[0]?.message || "Invalid message" });
      }
      
      // Content filtering
      const contentResult = filterContent(result.data.content);
      if (!contentResult.isClean || isSpamLike(result.data.content)) {
        return res.status(400).json({ error: "Message contains inappropriate content" });
      }
      
      const message = await storage.createTeamRoomMessage({
        senderId: userId,
        content: sanitizeText(result.data.content)
      });
      
      const sender = await storage.getUser(userId);
      res.json({
        ...message,
        sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, role: sender.role } : null
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Get online moderators in team room
  app.get("/api/team-room/online", requireRole("moderator", "head_of_moderation", "founder"), async (_req, res) => {
    try {
      // Return list of users currently connected to team room WebSocket
      const onlineUsers = Array.from(teamRoomClients.values())
        .filter((client, i, arr) => arr.findIndex(x => x.userId === client.userId) === i)
        .map(client => ({
          id: client.userId,
          username: client.username,
          avatar: client.avatar,
          role: client.role
        }));
      res.json(onlineUsers);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Get WebSocket token for team room (authenticated endpoint)
  app.get("/api/team-room/ws-token", requireRole("moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const token = generateTeamRoomToken(userId);
      res.json({ token });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const httpServer = createServer(app);
  
  // ============ TEAM ROOM WEBSOCKET ============
  
  // WebSocket server for team room real-time chat
  const teamRoomWss = new WebSocketServer({ noServer: true });
  
  teamRoomWss.on('connection', async (ws: WebSocket, req) => {
    // Parse token from URL query (client gets token from authenticated endpoint)
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }
    
    // Validate the one-time token
    const userId = validateTeamRoomToken(token);
    if (!userId) {
      ws.close(4001, 'Invalid or expired token');
      return;
    }
    
    // Verify user exists and is a moderator
    const user = await storage.getUser(userId);
    if (!user || !['moderator', 'head_of_moderation', 'founder'].includes(user.role)) {
      ws.close(4003, 'Access denied');
      return;
    }
    
    // Store client connection
    const client: TeamRoomClient = {
      id: randomUUID(),
      ws,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      role: user.role
    };
    teamRoomClients.set(client.id, client);
    
    console.log(`[TeamRoom] ${user.username} joined the team room`);
    
    // Broadcast user joined to all clients
    broadcastTeamRoom({
      type: 'user_joined',
      user: { id: user.id, username: user.username, avatar: user.avatar, role: user.role }
    });
    
    // Send current online users to new client
    ws.send(JSON.stringify({
      type: 'online_users',
      users: Array.from(teamRoomClients.values())
        .filter((c, i, arr) => arr.findIndex(x => x.userId === c.userId) === i)
        .map(c => ({
          id: c.userId,
          username: c.username,
          avatar: c.avatar,
          role: c.role
        }))
    }));

    // Send the current list of voice calls so late joiners see all active calls
    ws.send(JSON.stringify({
      type: 'voice_calls_list',
      calls: serializeTeamRoomCalls()
    }));
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'chat_message') {
          // Validate and filter content
          const contentResult = filterContent(message.content || '');
          if (!contentResult.isClean || isSpamLike(message.content || '')) {
            ws.send(JSON.stringify({ type: 'error', message: 'Message contains inappropriate content' }));
            return;
          }
          
          // Save to storage
          const savedMessage = await storage.createTeamRoomMessage({
            senderId: userId,
            content: sanitizeText(message.content)
          });
          
          // Broadcast to all clients
          broadcastTeamRoom({
            type: 'chat_message',
            message: {
              ...savedMessage,
              sender: { id: user.id, username: user.username, avatar: user.avatar, role: user.role }
            }
          });
        } else if (message.type === 'typing') {
          // Broadcast typing indicator
          broadcastTeamRoom({
            type: 'typing',
            user: { id: user.id, username: user.username }
          }, userId);
        } else if (message.type === 'webrtc_signal') {
          // Forward WebRTC signaling to every connection of the target user
          const signalPayload = JSON.stringify({
            type: 'webrtc_signal',
            fromUserId: userId,
            fromUsername: user.username,
            signal: message.signal,
            signalType: message.signalType
          });
          getTeamRoomClientsForUser(message.targetUserId).forEach((tc) => {
            if (tc.ws.readyState === WebSocket.OPEN) tc.ws.send(signalPayload);
          });
        } else if (message.type === 'voice_call_start') {
          // Create a brand-new call alongside any existing ones - never replace.
          // If the user was in another call, leave it (that call persists for
          // its remaining participants). No list broadcast here - the final
          // broadcast after creating the call is the only one clients see, so
          // the initiator never observes a gap where they aren't in any call.
          removeUserFromTeamRoomCalls(user.id, false);
          const newCall: TeamRoomCall = {
            id: randomUUID(),
            initiatorId: user.id,
            initiatorUsername: user.username,
            participants: new Set([user.id]),
            createdAt: Date.now(),
          };
          teamRoomCalls.set(newCall.id, newCall);
          broadcastTeamRoom({
            type: 'voice_call_start',
            call: serializeTeamRoomCall(newCall),
            initiator: { id: user.id, username: user.username, avatar: user.avatar }
          });
          broadcastVoiceCalls();
        } else if (message.type === 'voice_call_join') {
          // Join a specific call (message.callId). If the user was in another
          // call, they leave it first - that call stays alive for whoever else
          // is still in it.
          const joinTarget = teamRoomCalls.get(message.callId);
          if (joinTarget) {
            if (!joinTarget.participants.has(user.id)) {
              removeUserFromTeamRoomCalls(user.id, false);
            }
            const stillThere = teamRoomCalls.get(message.callId);
            if (stillThere) {
              stillThere.participants.add(user.id);
              broadcastTeamRoom({
                type: 'voice_call_user_joined',
                callId: stillThere.id,
                user: { id: user.id, username: user.username, avatar: user.avatar }
              });
              broadcastVoiceCalls();
            }
          }
        } else if (message.type === 'voice_call_leave' || message.type === 'voice_call_end') {
          // Leave a specific call. If it empties out, the call is deleted.
          const leaveCall = message.callId ? teamRoomCalls.get(message.callId) : null;
          if (leaveCall) {
            leaveCall.participants.delete(user.id);
            if (leaveCall.participants.size === 0) {
              teamRoomCalls.delete(leaveCall.id);
              broadcastTeamRoom({ type: 'voice_call_ended', callId: leaveCall.id });
            } else {
              broadcastTeamRoom({ type: 'voice_call_user_left', callId: leaveCall.id, user: { id: user.id } });
            }
            broadcastVoiceCalls();
          }
        } else if (message.type === 'voice_call_close') {
          // Only the founder or head of moderation can force-close a call.
          if (user.role !== 'founder' && user.role !== 'head_of_moderation') {
            ws.send(JSON.stringify({ type: 'error', message: 'Only the founder or head of moderation can close a call' }));
            return;
          }
          const closeTarget = teamRoomCalls.get(message.callId);
          if (closeTarget) {
            teamRoomCalls.delete(closeTarget.id);
            broadcastTeamRoom({
              type: 'voice_call_ended',
              callId: closeTarget.id,
              closedBy: { id: user.id, username: user.username }
            });
            broadcastVoiceCalls();
          }
        }
      } catch (error) {
        console.error('[TeamRoom] Message error:', error);
      }
    });
    
    ws.on('close', () => {
      teamRoomClients.delete(client.id);
      console.log(`[TeamRoom] ${user.username} left the team room`);

      // Only drop call membership and announce the leave once the user has no
      // connections left (they may still have another tab open).
      if (getTeamRoomClientsForUser(user.id).length === 0) {
        removeUserFromTeamRoomCalls(userId);
        broadcastTeamRoom({
          type: 'user_left',
          user: { id: user.id, username: user.username }
        });
      }
    });
    
    ws.on('error', (error) => {
      console.error('[TeamRoom] WebSocket error:', error.message);
      teamRoomClients.delete(client.id);
    });
  });
  
  function broadcastTeamRoom(data: object, excludeUserId?: string) {
    const message = JSON.stringify(data);
    teamRoomClients.forEach((client) => {
      if (client.userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  function serializeTeamRoomCall(call: TeamRoomCall) {
    return {
      id: call.id,
      initiatorId: call.initiatorId,
      initiatorUsername: call.initiatorUsername,
      createdAt: call.createdAt,
      participants: Array.from(call.participants).map((participantId) => {
        const client = getTeamRoomClientsForUser(participantId)[0];
        return client
          ? { id: client.userId, username: client.username, avatar: client.avatar, role: client.role }
          : { id: participantId, username: 'Someone', avatar: null, role: null };
      }),
    };
  }

  function serializeTeamRoomCalls() {
    return Array.from(teamRoomCalls.values()).map(serializeTeamRoomCall);
  }

  function broadcastVoiceCalls() {
    broadcastTeamRoom({ type: 'voice_calls_list', calls: serializeTeamRoomCalls() });
  }

  function removeUserFromTeamRoomCalls(userId: string, broadcastList = true) {
    teamRoomCalls.forEach((call, callId) => {
      if (call.participants.delete(userId) && call.participants.size === 0) {
        teamRoomCalls.delete(callId);
        broadcastTeamRoom({ type: 'voice_call_ended', callId });
      }
    });
    if (broadcastList) broadcastVoiceCalls();
  }
  
  // =================== Group Chat Routes ===================

  // Get all group chats for the authenticated user
  app.get("/api/group-chats", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const groups = await storage.getGroupChatsForUser(userId);
      const user = await storage.getUser(userId);
      const isStaffView = !!user && ["staff", "moderator", "head_of_moderation", "founder"].includes(user.role);
      const enriched: any[] = [];
      for (const g of groups) {
        const meeting = await storage.getMeetingByGroupChat(g.id);
        // A closed meeting chat is gone for everyone except the moderator who
        // ran it (and moderation staff) — it must not linger in Messages.
        if (meeting && meeting.status === "closed" && meeting.moderatorId !== userId && !isStaffView) {
          continue;
        }
        const members = await storage.getGroupChatMembers(g.id);
        const memberUsers = await Promise.all(
          members.map(async (m) => {
            const u = await storage.getUser(m.userId);
            return u ? { id: u.id, username: u.username, avatar: u.avatar } : null;
          })
        );
        const lastMsgs = await storage.getGroupChatMessages(g.id);
        const lastMsg = lastMsgs[lastMsgs.length - 1] || null;
        enriched.push({
          ...g,
          members: memberUsers.filter(Boolean),
          memberRoles: Object.fromEntries(members.map(m => [m.userId, m.role || "member"])),
          lastMessage: lastMsg,
          isMeeting: !!meeting,
          meetingId: meeting?.id ?? null,
          meetingStatus: meeting?.status ?? null,
          meetingModeratorId: meeting?.moderatorId ?? null,
        });
      }
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching group chats:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create a new group chat
  app.post("/api/group-chats", requireAuth, async (req, res) => {
    try {
      const { name, memberIds } = z.object({
        name: z.string().min(1).max(100),
        memberIds: z.array(z.string()).min(1),
      }).parse(req.body);

      const userId = req.session.userId!;

      // A user cannot be added to a group chat by someone they have blocked.
      const memberUsers = await Promise.all(memberIds.map(mid => storage.getUser(mid)));
      for (let i = 0; i < memberIds.length; i++) {
        const mu = memberUsers[i];
        if (!mu) return res.status(404).json({ error: "One of the selected members was not found" });
        if (mu.id !== userId && (await storage.isBlocked(mu.id, userId))) {
          return res.status(403).json({ error: `You cannot add ${mu.username} to the group — they have blocked you` });
        }
      }

      const group = await storage.createGroupChat({ name, creatorId: userId });

      // Add creator + members
      const allMemberIds = Array.from(new Set([userId, ...memberIds]));
      await Promise.all(allMemberIds.map(mid => storage.addGroupChatMember({ groupId: group.id, userId: mid })));

      res.status(201).json(group);
    } catch (error) {
      console.error("Error creating group chat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get group chat details + members
  app.get("/api/group-chats/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });

      const members = await storage.getGroupChatMembers(group.id);
      const isMember = members.some(m => m.userId === userId);
      if (!isMember) return res.status(403).json({ error: "Not a member of this group" });

      const myMembership = members.find(m => m.userId === userId);
      const myRole = group.creatorId === userId ? "owner" : (myMembership?.role || "member");

      const memberUsers = await Promise.all(
        members.map(async (m) => {
          const u = await storage.getUser(m.userId);
          return u ? { id: u.id, username: u.username, avatar: u.avatar, role: u.role } : null;
        })
      );
      const meeting = await storage.getMeetingByGroupChat(group.id);
      // A closed meeting chat is gone for everyone except the moderator who
      // ran it (and moderation staff).
      if (meeting && meeting.status === "closed" && meeting.moderatorId !== userId) {
        const viewer = await storage.getUser(userId);
        const viewerIsStaff = !!viewer && ["staff", "moderator", "head_of_moderation", "founder"].includes(viewer.role);
        if (!viewerIsStaff) return res.status(404).json({ error: "Group chat not found" });
      }
      res.json({
        ...group,
        members: memberUsers.filter(Boolean),
        memberRoles: Object.fromEntries(members.map(m => [m.userId, m.role || "member"])),
        myRole,
        isMeeting: !!meeting,
        meetingId: meeting?.id ?? null,
        meetingStatus: meeting?.status ?? null,
        meetingModeratorId: meeting?.moderatorId ?? null,
      });
    } catch (error) {
      console.error("Error fetching group chat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Shared helper: resolve the current user's group role.
  // "owner" = creator, "editor" = member with editor rights, otherwise "member".
  async function getGroupRole(group: { creatorId: string; id: string }, userId: string): Promise<string> {
    if (group.creatorId === userId) return "owner";
    const members = await storage.getGroupChatMembers(group.id);
    return members.find(m => m.userId === userId)?.role || "member";
  }

  // Rename a group chat (owner or editor; moderator-only for meeting chats)
  app.patch("/api/group-chats/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      const meeting = await storage.getMeetingByGroupChat(group.id);
      if (meeting && meeting.moderatorId !== userId) {
        return res.status(403).json({ error: "Only the moderator can change this meeting chat" });
      }
      const role = await getGroupRole(group, userId);
      if (role === "member") return res.status(403).json({ error: "Only the owner or an editor can rename this group" });
      const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
      const updated = await storage.updateGroupChat(group.id, { name });
      res.json(updated);
    } catch (error) {
      console.error("Error renaming group chat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Add member to group chat (owner or editor; moderator-only for meeting chats)
  app.post("/api/group-chats/:id/members", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      const meeting = await storage.getMeetingByGroupChat(group.id);
      if (meeting && meeting.moderatorId !== userId) {
        return res.status(403).json({ error: "Only the moderator can change this meeting chat" });
      }
      const role = await getGroupRole(group, userId);
      if (role === "member") return res.status(403).json({ error: "Only the owner or an editor can add members" });
      const { userId: newMemberId } = z.object({ userId: z.string() }).parse(req.body);
      const targetUser = await storage.getUser(newMemberId);
      if (!targetUser) return res.status(404).json({ error: "User not found" });
      // A user cannot be added to a group chat by someone they have blocked.
      if (await storage.isBlocked(newMemberId, userId)) {
        return res.status(403).json({ error: `You cannot add ${targetUser.username} — they have blocked you` });
      }
      const existing = await storage.getGroupChatMembers(group.id);
      if (existing.some(m => m.userId === newMemberId)) return res.status(400).json({ error: "User is already a member" });
      await storage.addGroupChatMember({ groupId: group.id, userId: newMemberId });
      // System message
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: `${targetUser.username} joined the chat`,
        isSystemMessage: true,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error adding group member:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Promote/demote an editor (owner only)
  app.put("/api/group-chats/:id/members/:userId/role", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      if (group.creatorId !== userId) return res.status(403).json({ error: "Only the owner can change member roles" });
      if (req.params.userId === userId) return res.status(400).json({ error: "The owner's role cannot be changed" });
      const { role } = z.object({ role: z.enum(["member", "editor"]) }).parse(req.body);
      const members = await storage.getGroupChatMembers(group.id);
      const target = members.find(m => m.userId === req.params.userId);
      if (!target) return res.status(404).json({ error: "User is not a member of this group" });
      await storage.updateGroupChatMemberRole(group.id, req.params.userId, role);
      const targetUser = await storage.getUser(req.params.userId);
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: role === "editor"
          ? `${targetUser?.username || "A member"} is now an editor`
          : `${targetUser?.username || "A member"} is no longer an editor`,
        isSystemMessage: true,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error changing group member role:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Transfer ownership (owner only)
  app.put("/api/group-chats/:id/transfer-ownership", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      if (group.creatorId !== userId) return res.status(403).json({ error: "Only the owner can transfer ownership" });
      const { userId: newOwnerId } = z.object({ userId: z.string() }).parse(req.body);
      const members = await storage.getGroupChatMembers(group.id);
      if (!members.some(m => m.userId === newOwnerId)) {
        return res.status(400).json({ error: "The new owner must be a member of the group" });
      }
      if (newOwnerId === userId) return res.status(400).json({ error: "You already own this group" });
      await storage.updateGroupChat(group.id, { creatorId: newOwnerId });
      // The new owner may keep their editor flag; it is ignored while they are owner.
      const oldOwnerUser = await storage.getUser(userId);
      const newOwnerUser = await storage.getUser(newOwnerId);
      // The previous owner becomes a regular member of the group they handed off.
      await storage.removeGroupChatMember(group.id, userId);
      await storage.addGroupChatMember({ groupId: group.id, userId, role: "member" });
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: `${oldOwnerUser?.username || "The owner"} transferred ownership to ${newOwnerUser?.username || "a member"}`,
        isSystemMessage: true,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error transferring group ownership:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove member from group chat. The owner can kick anyone except themselves;
  // an editor can kick everyone except the owner and other editors;
  // plain members cannot kick. Moderator-only for meeting chats.
  app.delete("/api/group-chats/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      const meeting = await storage.getMeetingByGroupChat(group.id);
      if (meeting && meeting.moderatorId !== userId) {
        return res.status(403).json({ error: "Only the moderator can change this meeting chat" });
      }
      if (req.params.userId === userId) return res.status(400).json({ error: "Cannot remove yourself — leave the group instead" });
      const actorRole = await getGroupRole(group, userId);
      if (actorRole === "member") {
        return res.status(403).json({ error: "Only the owner or an editor can remove members" });
      }
      const targetRole = req.params.userId === group.creatorId
        ? "owner"
        : (await storage.getGroupChatMembers(group.id)).find(m => m.userId === req.params.userId)?.role || "member";
      if (actorRole === "editor" && (targetRole === "owner" || targetRole === "editor")) {
        return res.status(403).json({ error: "Editors cannot remove the owner or other editors" });
      }
      const removedUser = await storage.getUser(req.params.userId);
      const remover = await storage.getUser(userId);
      await storage.removeGroupChatMember(group.id, req.params.userId);
      // System message
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: `${remover?.username || "An editor"} kicked ${removedUser?.username || "a member"} from the chat`,
        isSystemMessage: true,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing group member:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Leave a group chat (any member; blocked for meeting chats — only the moderator
  // may end a meeting, via the close endpoint)
  app.delete("/api/group-chats/:id/leave", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group not found" });
      const meeting = await storage.getMeetingByGroupChat(group.id);
      if (meeting) {
        return res.status(403).json({ error: "You cannot leave a moderator meeting — the moderator will close it when it ends." });
      }
      const leavingUser = await storage.getUser(userId);
      const wasOwner = group.creatorId === userId;
      await storage.removeGroupChatMember(group.id, userId);
      // If the owner leaves, hand ownership to the first remaining member so
      // the group always has exactly one owner.
      if (wasOwner) {
        const remaining = await storage.getGroupChatMembers(group.id);
        if (remaining.length > 0) {
          await storage.updateGroupChat(group.id, { creatorId: remaining[0].userId });
          const newOwner = await storage.getUser(remaining[0].userId);
          await storage.createGroupChatMessage({
            groupId: group.id,
            senderId: "system",
            message: `${newOwner?.username || "A member"} is now the owner`,
            isSystemMessage: true,
          });
        }
      }
      // System message
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: `${leavingUser?.username || "A member"} left the chat`,
        isSystemMessage: true,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error leaving group chat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get messages in a group chat
  app.get("/api/group-chats/:id/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      const members = await storage.getGroupChatMembers(group.id);
      if (!members.some(m => m.userId === userId)) return res.status(403).json({ error: "Not a member" });
      const messages = await storage.getGroupChatMessages(group.id);
      const enriched = await Promise.all(
        messages.map(async (msg) => {
          const sender = await storage.getUser(msg.senderId);
          return {
            ...msg,
            senderUsername: sender?.username || null,
            senderAvatar: sender?.avatar || null,
          };
        })
      );
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching group messages:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Send a message to a group chat
  app.post("/api/group-chats/:id/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const group = await storage.getGroupChat(req.params.id);
      if (!group) return res.status(404).json({ error: "Group chat not found" });
      const members = await storage.getGroupChatMembers(group.id);
      if (!members.some(m => m.userId === userId)) return res.status(403).json({ error: "Not a member" });

      // If this chat is a moderator meeting, the moderator controls who may speak
      const meeting = await storage.getMeetingByGroupChat(group.id);
      if (meeting && meeting.status === "active" && meeting.moderatorId !== userId) {
        if ((meeting.mutedUserIds || []).includes(userId)) {
          return res.status(403).json({ error: "You are muted. The moderator controls who can speak in this meeting." });
        }
      }

      const { message } = z.object({ message: z.string().min(1).max(2000) }).parse(req.body);
      const msg = await storage.createGroupChatMessage({ groupId: group.id, senderId: userId, message });
      res.status(201).json(msg);
    } catch (error) {
      console.error("Error sending group message:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================================
  // Freelancer Leaving a Job
  // ============================================================

  // Freelancer abandons/leaves a job. They are removed immediately.
  app.post("/api/jobs/:id/leave", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      if (!user || user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can leave a job" });
      }

      const freelancerIds = await getJobFreelancerIds(job);
      if (!freelancerIds.includes(userId)) {
        return res.status(403).json({ error: "You are not assigned to this job" });
      }

      const { reason } = z.object({ reason: z.string().max(2000).optional() }).parse(req.body);
      const remaining = freelancerIds.filter(id => id !== userId);

      // Remove from collaborators array
      const collaborators = (job.collaborators || []).filter((id: string) => id !== userId);

      // Remove any jobFreelancers record
      const jfRecords = await storage.getJobFreelancers(job.id);
      if (jfRecords.some(jf => jf.freelancerId === userId)) {
        await storage.removeJobFreelancer(job.id, userId);
      }

      const updates: any = { collaborators };
      const currentLeader = job.projectLeaderId || job.freelancerId;

      if (job.freelancerId === userId) {
        // The lead left: promote the next remaining freelancer, or unassign the job
        const next = remaining[0] || null;
        updates.freelancerId = next;
        updates.projectLeaderId = null; // effective leader becomes the new freelancerId
        if (!next) {
          updates.status = "active"; // no freelancers left — open the job again
        }
      } else if (currentLeader === userId) {
        // A non-lead freelancer who became project leader (e.g., via a vote) left
        updates.projectLeaderId = null; // leadership falls back to freelancerId
      }

      await storage.updateJob(job.id, updates);

      // Notify the customer
      await storage.createNotification({
        userId: job.customerId,
        type: "job_left",
        title: "A freelancer left your job",
        message: reason
          ? `${user.username} left "${job.title}" and shared a reason: ${reason}`
          : `${user.username} left "${job.title}".`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      // Notify remaining freelancers
      for (const fid of remaining) {
        await storage.createNotification({
          userId: fid,
          type: "job_left",
          title: "A teammate left the job",
          message: `${user.username} left "${job.title}".`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      // Leaving a job counts against the freelancer's completion rate
      await penalizeFreelancerCompletion(userId);

      res.json({ success: true, job });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error leaving job:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Optional: freelancer shares why they left (after already being removed)
  app.post("/api/jobs/:id/leave-reason", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      const { reason } = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const user = await storage.getUser(req.session.userId!);
      await storage.createNotification({
        userId: job.customerId,
        type: "job_left",
        title: "Why a freelancer left",
        message: `${user?.username || "A freelancer"} left "${job.title}" and shared a reason: ${reason}`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error recording leave reason:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================================
  // Abandon Requests — freelancer asks permission to leave a job
  // ============================================================

  // Shared helper: remove a freelancer from a job and fix up leadership.
  // When penalize is true, the removal counts against their completion rate.
  async function removeFreelancerFromJob(job: any, userId: string, penalize: boolean) {
    const user = await storage.getUser(userId);
    if (!user) return null;

    const freelancerIds = await getJobFreelancerIds(job);
    if (!freelancerIds.includes(userId)) return null;

    const remaining = freelancerIds.filter(id => id !== userId);
    const collaborators = (job.collaborators || []).filter((id: string) => id !== userId);

    const jfRecords = await storage.getJobFreelancers(job.id);
    if (jfRecords.some(jf => jf.freelancerId === userId)) {
      await storage.removeJobFreelancer(job.id, userId);
    }

    const updates: any = { collaborators };
    const currentLeader = job.projectLeaderId || job.freelancerId;

    if (job.freelancerId === userId) {
      const next = remaining[0] || null;
      updates.freelancerId = next;
      updates.projectLeaderId = null;
      if (!next) updates.status = "active";
    } else if (currentLeader === userId) {
      updates.projectLeaderId = null;
    }

    await storage.updateJob(job.id, updates);

    if (penalize) {
      await penalizeFreelancerCompletion(userId);
    }

    return { user, remaining };
  }

  // Freelancer requests to abandon a job. Goes to the customer for approval first.
  app.post("/api/jobs/:id/abandon-request", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      if (!user || user.role !== "freelancer") {
        return res.status(403).json({ error: "Only freelancers can abandon a job" });
      }

      const freelancerIds = await getJobFreelancerIds(job);
      if (!freelancerIds.includes(userId)) {
        return res.status(403).json({ error: "You are not assigned to this job" });
      }

      const { reason, links, proofUrl } = z.object({
        reason: z.string().min(10, "Reason must be at least 10 characters"),
        links: z.string().max(4000).optional(),
        proofUrl: z.string().max(4000).optional(),
      }).parse(req.body);

      const existing = await storage.getAbandonRequests({ jobId: job.id, freelancerId: userId });
      if (existing.some(r => r.status === AbandonStatus.PENDING_CUSTOMER || r.status === AbandonStatus.PENDING_MODERATOR)) {
        return res.status(400).json({ error: "You already have a pending abandon request for this job" });
      }

      const request = await storage.createAbandonRequest({
        jobId: job.id,
        freelancerId: userId,
        reason,
        links: links || null,
        proofUrl: proofUrl || null,
        status: AbandonStatus.PENDING_CUSTOMER,
      });

      await storage.createNotification({
        userId: job.customerId,
        type: "abandon_request",
        title: "A freelancer wants to abandon your job",
        message: `${user.username} requested to leave "${job.title}". Reason: ${reason}`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.status(201).json({ success: true, request });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error creating abandon request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Abandon requests for a job (visible to the customer and assigned freelancers)
  app.get("/api/abandon-requests/job/:jobId", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const userId = req.session.userId!;
      const freelancerIds = await getJobFreelancerIds(job);
      if (job.customerId !== userId && !freelancerIds.includes(userId)) {
        return res.status(403).json({ error: "Not a member of this job" });
      }

      const requests = await storage.getAbandonRequests({ jobId: job.id });
      const enriched = await Promise.all(requests.map(async (r) => {
        const freelancer = await storage.getUser(r.freelancerId);
        return { ...r, freelancerUsername: freelancer?.username || "Unknown" };
      }));
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching abandon requests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // All abandon requests for the moderation queue (enriched with job + freelancer)
  app.get("/api/abandon-requests", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (_req, res) => {
    try {
      const requests = await storage.getAllAbandonRequests();
      const enriched = [];
      for (const r of requests) {
        const job = await storage.getJob(r.jobId);
        const freelancer = await storage.getUser(r.freelancerId);
        enriched.push({
          ...r,
          jobTitle: job?.title || "Unknown Job",
          jobBudget: job?.budget || null,
          freelancerUsername: freelancer?.username || "Unknown",
        });
      }
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching all abandon requests:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer approves: freelancer excused, removed without a completion-rate penalty.
  app.post("/api/abandon-requests/:id/customer-approve", requireAuth, async (req, res) => {
    try {
      const request = await storage.getAbandonRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Abandon request not found" });
      const job = await storage.getJob(request.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const userId = req.session.userId!;
      if (job.customerId !== userId) {
        return res.status(403).json({ error: "Only the customer can approve this request" });
      }
      if (request.status !== AbandonStatus.PENDING_CUSTOMER) {
        return res.status(400).json({ error: "This request is no longer awaiting customer approval" });
      }

      await removeFreelancerFromJob(job, request.freelancerId, false);
      await storage.updateAbandonRequest(request.id, { status: AbandonStatus.APPROVED, decidedBy: userId });

      await storage.createNotification({
        userId: request.freelancerId,
        type: "abandon_approved",
        title: "Abandon request approved",
        message: `The customer approved your request to leave "${job.title}". You have been excused without affecting your completion rate.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error approving abandon request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer declines: the request is forwarded to the moderation queue.
  app.post("/api/abandon-requests/:id/customer-decline", requireAuth, async (req, res) => {
    try {
      const request = await storage.getAbandonRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Abandon request not found" });
      const job = await storage.getJob(request.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const userId = req.session.userId!;
      if (job.customerId !== userId) {
        return res.status(403).json({ error: "Only the customer can decline this request" });
      }
      if (request.status !== AbandonStatus.PENDING_CUSTOMER) {
        return res.status(400).json({ error: "This request is no longer awaiting customer approval" });
      }

      await storage.updateAbandonRequest(request.id, { status: AbandonStatus.PENDING_MODERATOR, decidedBy: userId });

      await storage.createNotification({
        userId: request.freelancerId,
        type: "abandon_forwarded",
        title: "Abandon request sent to moderation",
        message: `The customer did not approve your request to leave "${job.title}". It has been forwarded to the moderation team for review.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error declining abandon request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator approves: freelancer excused, removed without a completion-rate penalty.
  app.post("/api/abandon-requests/:id/moderator-approve", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.getAbandonRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Abandon request not found" });
      const job = await storage.getJob(request.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      if (request.status !== AbandonStatus.PENDING_MODERATOR) {
        return res.status(400).json({ error: "This request is not awaiting moderator review" });
      }

      const moderatorId = req.session.userId!;
      await removeFreelancerFromJob(job, request.freelancerId, false);
      await storage.updateAbandonRequest(request.id, { status: AbandonStatus.APPROVED, decidedBy: moderatorId });

      await storage.createNotification({
        userId: request.freelancerId,
        type: "abandon_approved",
        title: "Abandon request approved",
        message: `A moderator approved your request to leave "${job.title}". You have been excused without affecting your completion rate.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });
      await storage.createNotification({
        userId: job.customerId,
        type: "abandon_approved",
        title: "Freelancer excused from your job",
        message: `A moderator approved a request for a freelancer to leave "${job.title}".`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error approving abandon request (moderator):", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator declines: the freelancer is not excused and stays on the job.
  app.post("/api/abandon-requests/:id/moderator-decline", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const request = await storage.getAbandonRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Abandon request not found" });
      const job = await storage.getJob(request.jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      if (request.status !== AbandonStatus.PENDING_MODERATOR) {
        return res.status(400).json({ error: "This request is not awaiting moderator review" });
      }

      const moderatorId = req.session.userId!;
      await storage.updateAbandonRequest(request.id, { status: AbandonStatus.DECLINED, decidedBy: moderatorId });

      await storage.createNotification({
        userId: request.freelancerId,
        type: "abandon_declined",
        title: "Abandon request declined",
        message: `A moderator declined your request to leave "${job.title}". You are expected to complete the job.`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });
      await storage.createNotification({
        userId: job.customerId,
        type: "abandon_declined",
        title: "Freelancer must stay on your job",
        message: `A moderator declined a freelancer's request to leave "${job.title}".`,
        relatedId: job.id,
        sourceType: "job",
        sourceId: job.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error declining abandon request (moderator):", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  // ============================================================
  // Project Leader Voting
  // ============================================================

  // Customer starts a vote to change who the Project Leader is
  app.post("/api/jobs/:id/project-leader-vote", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can start a leadership vote" });
      }
      const { candidateId } = z.object({ candidateId: z.string().min(1) }).parse(req.body);

      const existing = await storage.getActiveLeadershipVoteByJob(job.id);
      if (existing) {
        return res.status(400).json({ error: "A leadership vote is already open for this job" });
      }

      const freelancerIds = await getJobFreelancerIds(job);
      if (freelancerIds.length < 2) {
        return res.status(400).json({ error: "This job needs at least two freelancers to hold a leadership vote" });
      }
      const currentLeader = job.projectLeaderId || job.freelancerId;
      if (candidateId === currentLeader) {
        return res.status(400).json({ error: "This freelancer is already the Project Leader" });
      }
      if (!freelancerIds.includes(candidateId)) {
        return res.status(400).json({ error: "The candidate must be a freelancer on this job" });
      }

      const vote = await storage.createLeadershipVote({
        jobId: job.id,
        initiatedById: req.session.userId!,
        candidateId,
      });

      const candidate = await storage.getUser(candidateId);
      for (const fid of freelancerIds) {
        await storage.createNotification({
          userId: fid,
          type: "leadership_vote",
          title: "Project Leader vote started",
          message: `A vote is open to make ${candidate?.username || "a freelancer"} the Project Leader for "${job.title}". Cast your vote in Current Job.`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.status(201).json(vote);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error starting leadership vote:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Freelancer casts an anonymous vote
  app.post("/api/jobs/:id/project-leader-vote/cast", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      const freelancerIds = await getJobFreelancerIds(job);
      if (!freelancerIds.includes(req.session.userId!)) {
        return res.status(403).json({ error: "Only freelancers on this job can vote" });
      }
      const vote = await storage.getActiveLeadershipVoteByJob(job.id);
      if (!vote) return res.status(404).json({ error: "No open leadership vote for this job" });

      const { choice } = z.object({ choice: z.enum([LeadershipVoteChoice.AGREE, LeadershipVoteChoice.DISAPPROVE]) }).parse(req.body);

      const existingCast = await storage.getLeadershipVoteCast(vote.id, req.session.userId!);
      if (existingCast) return res.status(400).json({ error: "You have already voted" });

      await storage.createLeadershipVoteCast({ voteId: vote.id, voterId: req.session.userId!, choice });

      const casts = await storage.getLeadershipVoteCasts(vote.id);
      const agreeCount = casts.filter(c => c.choice === LeadershipVoteChoice.AGREE).length;
      const disapproveCount = casts.filter(c => c.choice === LeadershipVoteChoice.DISAPPROVE).length;
      const totalEligible = freelancerIds.length;

      let passed = false;
      let failed = false;
      if (agreeCount * 2 >= totalEligible) {
        passed = true;
      } else if (disapproveCount * 2 > totalEligible) {
        failed = true;
      }

      const candidate = await storage.getUser(vote.candidateId);
      if (passed) {
        await storage.updateLeadershipVote(vote.id, { status: LeadershipVoteStatus.PASSED, closedAt: new Date() });
        await storage.updateJob(job.id, { projectLeaderId: vote.candidateId });
        for (const fid of freelancerIds) {
          await storage.createNotification({
            userId: fid,
            type: "leadership_vote",
            title: "Project Leader changed",
            message: `${candidate?.username || "A freelancer"} is now the Project Leader for "${job.title}".`,
            relatedId: job.id,
            sourceType: "job",
            sourceId: job.id,
          });
        }
        await storage.createNotification({
          userId: job.customerId,
          type: "leadership_vote",
          title: "Project Leader changed",
          message: `${candidate?.username || "A freelancer"} is now the Project Leader for "${job.title}".`,
          relatedId: job.id,
          sourceType: "job",
          sourceId: job.id,
        });
      } else if (failed) {
        await storage.updateLeadershipVote(vote.id, { status: LeadershipVoteStatus.FAILED, closedAt: new Date() });
      }

      res.json({ success: true, passed, failed, agreeCount, disapproveCount, totalEligible });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error casting leadership vote:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Customer cancels an open leadership vote
  app.post("/api/jobs/:id/project-leader-vote/cancel", requireAuth, async (req, res) => {
    try {
      const job = await storage.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if (job.customerId !== req.session.userId) {
        return res.status(403).json({ error: "Only the job owner can cancel this vote" });
      }
      const vote = await storage.getActiveLeadershipVoteByJob(job.id);
      if (!vote) return res.status(404).json({ error: "No open leadership vote for this job" });
      await storage.updateLeadershipVote(vote.id, { status: LeadershipVoteStatus.CANCELLED, closedAt: new Date() });
      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling leadership vote:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================================
  // Moderator Meetings (court-room group chat)
  // ============================================================

  // Moderator creates (or reopens) a meeting room for a job
  app.post("/api/meetings", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.body);
      const job = await storage.getJob(jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      const existing = await storage.getActiveMeetingByJob(jobId);
      if (existing) {
        return res.json({ ...existing, reopened: false });
      }

      const moderatorId = req.session.userId!;
      const participantIds = new Set<string>([moderatorId, job.customerId]);
      for (const fid of await getJobFreelancerIds(job)) participantIds.add(fid);

      const moderator = await storage.getUser(moderatorId);
      const group = await storage.createGroupChat({
        name: `Meeting: ${job.title}`.slice(0, 100),
        creatorId: moderatorId,
      });
      // The moderator must be a member of the chat so it shows in their
      // Messages and they can manage/delete it from the three-dots menu.
      await storage.addGroupChatMember({ groupId: group.id, userId: moderatorId });
      for (const pid of Array.from(participantIds)) {
        await storage.addGroupChatMember({ groupId: group.id, userId: pid });
      }
      await storage.createGroupChatMessage({
        groupId: group.id,
        senderId: "system",
        message: `Moderator ${moderator?.username || "Moderator"} opened a meeting about "${job.title}". This is a court room — the moderator controls who may speak.`,
        isSystemMessage: true,
      });

      const meeting = await storage.createMeeting({
        jobId: job.id,
        groupChatId: group.id,
        moderatorId,
      });

      for (const pid of Array.from(participantIds)) {
        if (pid === moderatorId) continue;
        await storage.createNotification({
          userId: pid,
          type: "meeting_started",
          title: "A moderator opened a meeting",
          message: `A moderator opened a meeting about "${job.title}". Tap to join the discussion.`,
          relatedId: meeting.id,
          sourceType: "job",
          sourceId: job.id,
        });
      }

      res.status(201).json(meeting);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error creating meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get meeting details + participants (moderator or any participant)
  app.get("/api/meetings/:id", requireAuth, async (req, res) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });
      const userId = req.session.userId!;
      const members = await storage.getGroupChatMembers(meeting.groupChatId);
      const isModerator = meeting.moderatorId === userId;
      const isParticipant = members.some(m => m.userId === userId);
      const user = await storage.getUser(userId);
      const isStaff = !!user && ["staff", "moderator", "head_of_moderation", "founder"].includes(user.role);
      if (!isParticipant && !isStaff) return res.status(403).json({ error: "Not a participant of this meeting" });

      // A closed meeting is deleted for everyone except the moderator who ran it
      // (and moderation staff). Non-moderator participants see it as gone.
      if (meeting.status === "closed" && !isModerator && !isStaff) {
        return res.status(404).json({ error: "Meeting not found" });
      }

      const group = await storage.getGroupChat(meeting.groupChatId);
      const job = await storage.getJob(meeting.jobId);
      const memberUsers = await Promise.all(
        members.map(async (m) => {
          const u = await storage.getUser(m.userId);
          return u ? { id: u.id, username: u.username, avatar: u.avatar, role: u.role } : null;
        })
      );

      res.json({
        ...meeting,
        jobTitle: job?.title || null,
        jobStatus: job?.status || null,
        group,
        participants: memberUsers.filter(Boolean),
        canControl: isModerator || isStaff,
        amMuted: (meeting.mutedUserIds || []).includes(userId),
      });
    } catch (error) {
      console.error("Error fetching meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator toggles who may type in the meeting
  app.post("/api/meetings/:id/toggle-mute", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
      if (userId === meeting.moderatorId) {
        return res.status(400).json({ error: "The moderator always controls the floor" });
      }
      const muted = new Set(meeting.mutedUserIds || []);
      if (muted.has(userId)) muted.delete(userId); else muted.add(userId);
      const updated = await storage.updateMeeting(meeting.id, { mutedUserIds: Array.from(muted) });
      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request" });
      console.error("Error toggling mute:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator closes the meeting — deletes it for all participants (freelancers,
  // customers, and the moderator themselves). The court-room chat is removed entirely.
  app.post("/api/meetings/:id/close", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });
      // Close instead of delete: the meeting disappears for all non-moderator
      // participants, but the moderator keeps the record (messages intact) until
      // they delete it via DELETE /api/meetings/:id.
      await storage.updateMeeting(meeting.id, { status: "closed" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error closing meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Moderator permanently deletes a closed meeting to free up space.
  app.delete("/api/meetings/:id", requireRole("staff", "moderator", "head_of_moderation", "founder"), async (req, res) => {
    try {
      const meeting = await storage.getMeeting(req.params.id);
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });
      await storage.deleteGroupChat(meeting.groupChatId);
      await storage.deleteMeeting(meeting.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting meeting:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Set up WebSocket server for real-time price broadcasts
  const wss = new WebSocketServer({ noServer: true });
  
  // Initialize crypto price service
  const priceService = getCryptoPriceService();
  
  wss.on('connection', (ws: WebSocket) => {
    console.log('[WebSocket] Client connected to price feed');
    
    // Send current prices immediately on connection
    const currentPrices = priceService.getCurrentPrices();
    ws.send(JSON.stringify({
      type: 'prices',
      data: currentPrices
    }));
    
    ws.on('error', (error) => {
      console.error('[WebSocket] Client error:', error.message);
    });
    
    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected from price feed');
    });
  });
  
  // Broadcast price updates every 3 seconds to all connected clients
  setInterval(() => {
    const currentPrices = priceService.getCurrentPrices();
    const priceData = {
      type: 'prices',
      data: currentPrices
    };
    
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(priceData));
      }
    });
  }, 3000); // Broadcast every 3 seconds
  
  // Route WebSocket upgrades by path. Each WebSocketServer is created with
  // noServer:true so a non-matching path isn’t aborted by ws (it destroys the
  // socket with a 400 otherwise, killing connections handled by the other server
  // sharing this HTTP server — e.g. the team room vs the price feed).
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/ws/team-room") {
      teamRoomWss.handleUpgrade(req, socket, head, (ws) => {
        teamRoomWss.emit("connection", ws, req);
      });
    } else if (pathname === "/ws/prices") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  return httpServer;
}
