# Linxova - Professional Freelancer Job Marketplace

## Overview
Linxova is a full-stack job marketplace designed to connect freelancers with customers through a moderated platform. It offers secure payment processing, real-time Discord integrations, and comprehensive freelancer management tools. The platform aims to provide a seamless and secure environment for project collaboration, featuring role-based access control, automated profit splitting for team projects, and a robust job moderation system. Linxova's vision is to become a leading platform in the freelance economy by efficiently matching talent with opportunities.

## User Preferences
I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture
Linxova is built with a React frontend, an Express Node.js backend, and MongoDB Atlas for data persistence.

**UI/UX Decisions:**
- **Branding:** Consistent Linxova branding throughout the platform.
- **Components:** Utilizes Shadcn UI components and Tailwind CSS for a modern and responsive user interface.
- **Typography:** Employs Inter and JetBrains Mono fonts for readability.
- **Timezone:** All dates and times are standardized and displayed in Eastern Time (ET).

**Technical Implementations & Feature Specifications:**
- **Authentication:** Discord OAuth is used for user authentication, implementing role-based access control (Freelancer, Customer, Staff, Moderator).
- **Job Board & Application System:** Users can browse and search approved jobs. It includes a job application queue system with a maximum of 5 pending applications per freelancer. Customers manage applications, with automatic cancellation of other pending applications upon acceptance. Jobs progress through a state machine: DRAFT → PENDING_APPROVAL → PENDING_ACCEPTANCE → IN_PROGRESS → AWAITING_CUSTOMER → COMPLETED, with alternative paths for cancellation, dispute, or expiration.
- **Wallet & Payments:** A USD-based balance tracking system with deposit/withdrawal functionalities and transaction history. An escrow payment system deducts funds upon job submission for review and manages refunds and freelancer payouts based on a level-based percentage.
- **Freelancer Management:** Freelancer profiles display completed jobs, statistics, a leveling system, ratings/reviews, and PTO request management.
- **Moderation & Staff Tools:**
    - **Moderation Queue:** For approving/rejecting job posts and managing user reports.
    - **Moderator PTO System:** Allows all moderation roles to submit and manage PTO requests. When approved, the PTO is automatically added to the shared Team Calendar as a distinct amber-colored entry visible to all moderation staff.
    - **Team Calendar:** A shared calendar tab in the moderation panel (moderators, head_of_moderation, founder). Month-view grid with day-click event creation, color-coded chips (blue = team event, amber = PTO), monthly events list with deletion, and 30-second auto-refresh. PTO approvals auto-populate it. Backend: `CalendarEvent` stored in `calendarEventsMap` with `GET/POST/DELETE /api/calendar/events`.
    - **Manage Funds Tab (Head of Moderation):** Enables setting and automatic weekly distribution of income to moderators and staff from the platform's vault.
    - **Moderator Task System:** Head of Moderation/Founder can assign personal or team-based tasks to moderators with priority and status tracking.
    - **Meeting & Calendar System:** Head of Moderation/Founder can schedule meetings for moderators, including RSVP functionality and notification system.
    - **Team Room:** A real-time collaboration space for the moderation team with persistent chat, typing indicators, and WebRTC-based voice calls.
- **Team Collaboration Suite:** Includes secure API endpoints for team notes, tasks, and real-time chat within job details, with automated profit splitting for multi-freelancer jobs.
- **Discord Integration:** Facilitates role synchronization, team collaboration notifications, and automatic posting of approved jobs via webhooks.
- **Notification Center:** A comprehensive system for categorized alerts, including dismiss functionality and specialized spam filtering for job requests.
- **Onboarding System:** A multi-step, role-specific onboarding wizard for new users.
- **Smart Search System:** Incorporates fuzzy matching, synonym expansion, and budget filtering.
- **Rating System:** Customers can rate freelancers post-completion, influencing freelancer averages.
- **Role Upgrade System:** Allows users to apply for role upgrades (e.g., Customer to Freelancer, Freelancer to Moderator) with a moderation review process.
- **Friends System:** Global user search, friend requests, and friends list management with quick message access.
- **Messaging System:** Supports direct messages and group chats. Group chats allow creation, member management, and message exchange. Enhanced UI displays sender avatars and usernames in messages, and offers privacy settings to control messages from unknown users.
- **Tutorial System:** Role-specific, slide-based walkthroughs for platform features.
- **Safety & Moderation:**
    - **Content Filter:** Server-side content filtering for inappropriate patterns, XSS sanitization, and spam detection.
    - **Report System:** Users can report jobs, users, messages, or bugs, with a dedicated moderation queue for review and resolution.
    - **Disciplinary Actions:** Moderators can issue warnings, suspend accounts (temporarily or permanently), with role hierarchy enforcement. Suspended users see a dedicated screen with suspension details and a countdown.
    - **Bug Forwarding:** Moderators can forward genuine bug reports to the development team.
- **Lino AI Assistant:** An AI-powered support chatbot integrated via OpenAI (gpt-5-mini model), accessible to all authenticated users with rate limiting and conversation history.
- **Premium Listing System:** Allows customers to pay a variable premium for higher job visibility on the job board, contributing to platform revenue.
- **Dispute Resolution:** Either party can initiate a dispute for active jobs, which are then resolved by a moderator with a split decision for fund distribution.
- **Cancellation System:** Allows job cancellation before freelancer acceptance (full refund) or initiates a negotiation period with auto-escalation to dispute if no agreement.
- **Scheduled Tasks:** Automated processes for job auto-completion, expiration, customer review reminders, and cancellation escalation.

**System Design Choices:**
- **Client-Side:** React with TypeScript, Wouter for routing, and TanStack Query for data fetching.
- **Server-Side:** Node.js with Express, leveraging TypeScript for type safety.
- **Storage:** MongoDB Atlas for persistent data, with an in-memory fallback for development.
- **Real-time:** WebSockets are utilized for live notifications and updates.
- **Project Structure:** Clearly organized into client, server, and shared directories.

## External Dependencies
- **Discord:** Used for OAuth authentication and webhooks for notifications and integrations.
- **MongoDB Atlas:** Cloud-hosted NoSQL database.
- **Shadcn UI:** UI component library.
- **Tailwind CSS:** Utility-first CSS framework.
- **Wouter:** React routing library.
- **TanStack Query:** Data fetching and caching library.
- **ws:** WebSocket library for backend real-time communication.
- **Express Session:** For managing user sessions.