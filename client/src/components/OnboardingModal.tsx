import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, ArrowRight, ArrowLeft } from "lucide-react";
import type { User } from "@shared/schema";

interface OnboardingStep {
  title: string;
  description: string;
  content: React.ReactNode;
}

interface OnboardingModalProps {
  user: User;
  open: boolean;
  onComplete: () => void;
}

const moderatorSteps: OnboardingStep[] = [
  {
    title: "Welcome to Moderator Tools",
    description: "As a moderator, you ensure quality and fairness on the platform.",
    content: (
      <div className="space-y-4">
        <p>Your role includes:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Reviewing and approving new job posts</li>
          <li>Handling cancellation requests with fairness</li>
          <li>Maintaining platform quality standards</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Reviewing Job Posts",
    description: "Navigate to Moderation Queue to review pending jobs.",
    content: (
      <div className="space-y-4">
        <p>When reviewing jobs, you can:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Approve:</strong> Job goes live on the marketplace</li>
          <li><strong>Request Changes:</strong> Send feedback to the customer</li>
          <li><strong>Reject:</strong> Decline the job entirely</li>
        </ul>
        <p className="text-sm text-muted-foreground mt-4">
          Always provide clear feedback when requesting changes or rejecting.
        </p>
      </div>
    ),
  },
  {
    title: "Cancellation Requests",
    description: "Handle freelancer and customer cancellation requests.",
    content: (
      <div className="space-y-4">
        <p>Review cancellation requests carefully:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Check the reason and evidence provided</li>
          <li>Jobs in certain statuses require your approval</li>
          <li>You can approve, decline, or request more evidence</li>
        </ul>
      </div>
    ),
  },
  {
    title: "PTO Approvals",
    description: "Manage freelancer paid time off requests.",
    content: (
      <div className="space-y-4">
        <p>Handling disputes properly:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Do not sway in favor of either side</li>
          <li>Act as a neutral third party, you are the jury and judge, so do not abuse power</li>
          <li>If they feel you are unfair and provide sufficient evidence, you may be let go</li>
        </ul>
      </div>
    ),
  },
];

const freelancerSteps: OnboardingStep[] = [
  {
    title: "Welcome to Linxova!",
    description: "Start earning as a freelancer on our platform.",
    content: (
      <div className="space-y-4">
        <p>Here's how to get started:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Browse available jobs in the Marketplace</li>
          <li>Request to take jobs that match your skills</li>
          <li>Work solo or collaborate on teams</li>
          <li>Receive payments to your wallet for completed work</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Finding Jobs",
    description: "Browse the marketplace and filter by category.",
    content: (
      <div className="space-y-4">
        <p>In the Marketplace:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Use search and filter to find jobs</li>
          <li>Click on jobs to see full details and budget</li>
          <li>Click "Claim Job" if eligible</li>
          <li><strong>One job at a time:</strong> Finish your current job before claiming another</li>
          <li>Cancel jobs anytime but you'll need a good reason</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Team Collaboration",
    description: "Work with other freelancers on larger projects.",
    content: (
      <div className="space-y-4">
        <p>If a job is already taken:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Click "Offer Team" to request to join</li>
          <li>Or invite friends to jobs you're working on</li>
          <li>Profits split equally among all team members regardless of participation</li>
          <li>Collaborate in the Current Job tab on job details</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Working Hours & Payouts",
    description: "Configure your schedule and understand your earnings.",
    content: (
      <div className="space-y-4">
        <p>Set up your profile:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Go to Profile to set your working hours</li>
          <li>Your level (1-5) determines payout percentage: Level 1 = 60%, Level 2 = 70%, Level 3 = 80%, Level 4 = 85%, Level 5 = 90%</li>
          <li>Level up by completing more jobs successfully</li>
        </ul>
      </div>
    ),
  },
];

const customerSteps: OnboardingStep[] = [
  {
    title: "Welcome, Customer!",
    description: "Post jobs and hire talented freelancers.",
    content: (
      <div className="space-y-4">
        <p>Getting started as a customer:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Create job posts with clear requirements</li>
          <li>Jobs are reviewed by moderators before going live</li>
          <li>Review freelancer requests to take your jobs</li>
          <li>Pay securely</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Creating Job Posts",
    description: "Navigate to Create Job to post a new opportunity.",
    content: (
      <div className="space-y-4">
        <p>When creating a job:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Write a clear title and detailed description</li>
          <li>Set a fair budget in USD</li>
          <li>Choose the appropriate category</li>
          <li>Set a deadline (minimum 3 weeks out)</li>
        </ul>
        <p className="text-sm text-muted-foreground mt-4">
          Jobs must be approved by moderators before going live.
        </p>
      </div>
    ),
  },
  {
    title: "Job Review Process",
    description: "Moderators review your jobs for quality.",
    content: (
      <div className="space-y-4">
        <p>After you submit a job:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Pending:</strong> Awaiting moderator review</li>
          <li><strong>Changes Requested:</strong> Moderator feedback provided - edit and resubmit</li>
          <li><strong>Approved:</strong> Job is live on the marketplace</li>
          <li><strong>Rejected:</strong> Job did not meet quality standards</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Managing Your Jobs",
    description: "Track and manage jobs in My Jobs.",
    content: (
      <div className="space-y-4">
        <p>In My Jobs you can:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>View all your jobs and their statuses</li>
          <li>Edit jobs that need changes</li>
          <li>Review freelancer requests</li>
          <li>Track job progress and completion</li>
        </ul>
      </div>
    ),
  },
];

const headOfModerationSteps: OnboardingStep[] = [
  {
    title: "Welcome, Head of Moderation!",
    description: "You lead the moderation team and oversee platform quality.",
    content: (
      <div className="space-y-4">
        <p>Your leadership responsibilities:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Oversee all moderation activities across the platform</li>
          <li>Manage and support your moderator team</li>
          <li>Set and enforce content quality standards</li>
          <li>Handle escalated disputes and complex cases</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Team Management",
    description: "Access Team Management to coordinate your moderators.",
    content: (
      <div className="space-y-4">
        <p>In Team Management you can:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>View all moderators and their workload</li>
          <li>Assign tasks to individual moderators</li>
          <li>Schedule team meetings and check-ins</li>
          <li>Monitor performance and response times</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Meeting Scheduling",
    description: "Organize meetings with your moderation team.",
    content: (
      <div className="space-y-4">
        <p>Schedule meetings effectively:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Create individual or team-wide meetings</li>
          <li>Set date, time, and duration</li>
          <li>Track RSVP responses from moderators</li>
          <li>All times displayed in Eastern Time (ET)</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Team Room",
    description: "Collaborate in real-time with your moderation team.",
    content: (
      <div className="space-y-4">
        <p>The Team Room offers:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Persistent team chat for quick discussions</li>
          <li>Voice calls for important conversations</li>
          <li>Online presence and typing indicators</li>
          <li>Content-filtered messaging for safety</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Moderation Vault",
    description: "Manage team compensation from the vault.",
    content: (
      <div className="space-y-4">
        <p>The Moderation Vault allows you to:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>View available funds from Founder deposits</li>
          <li>Distribute payments to moderators</li>
          <li>Track all vault transactions</li>
          <li>Ensure fair compensation for team work</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Reports & Escalations",
    description: "Handle user reports and role upgrade requests.",
    content: (
      <div className="space-y-4">
        <p>Your moderation duties include:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Review and resolve user reports promptly</li>
          <li>Process role upgrade applications</li>
          <li>Approve freelancer-to-moderator promotions</li>
          <li>Escalate serious issues to the Founder when needed</li>
        </ul>
      </div>
    ),
  },
];

const founderSteps: OnboardingStep[] = [
  {
    title: "Welcome, Founder!",
    description: "You have full administrative access to Linxova.",
    content: (
      <div className="space-y-4">
        <p>As the Founder, you can:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Access all platform features and data</li>
          <li>Manage the moderation vault</li>
          <li>Oversee all users, jobs, and transactions</li>
          <li>Make critical platform decisions</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Platform Overview",
    description: "Monitor the health of the entire platform.",
    content: (
      <div className="space-y-4">
        <p>Your dashboard shows:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Total users, jobs, and transaction volume</li>
          <li>Pending moderation queue status</li>
          <li>Active disputes and escalations</li>
          <li>Platform revenue and growth metrics</li>
        </ul>
      </div>
    ),
  },
];

function getStepsForRole(role: string): OnboardingStep[] {
  switch (role) {
    case "founder":
      return founderSteps;
    case "head_of_moderation":
      return headOfModerationSteps;
    case "moderator":
    case "staff":
      return moderatorSteps;
    case "customer":
      return customerSteps;
    case "freelancer":
    default:
      return freelancerSteps;
  }
}

export function OnboardingModal({ user, open, onComplete }: OnboardingModalProps) {
  const [currentStep, setCurrentStep] = useState(0);

  const steps = getStepsForRole(user.role);

  const progress = ((currentStep + 1) / steps.length) * 100;

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleClose = () => {
    setCurrentStep(0);
    onComplete();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="max-w-2xl" data-testid="dialog-onboarding">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="text-onboarding-title">
            {steps[currentStep].title}
          </DialogTitle>
          <DialogDescription data-testid="text-onboarding-description">
            {steps[currentStep].description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <Progress value={progress} className="w-full" data-testid="progress-onboarding" />

          <div className="min-h-[200px]" data-testid="content-onboarding-step">
            {steps[currentStep].content}
          </div>

          <div className="text-sm text-muted-foreground text-center" data-testid="text-step-indicator">
            Step {currentStep + 1} of {steps.length}
          </div>
        </div>

        <DialogFooter className="flex justify-between gap-2">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 0}
            data-testid="button-onboarding-back"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>

          <Button onClick={handleNext} data-testid="button-onboarding-next">
            {currentStep === steps.length - 1 ? (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Get Started
              </>
            ) : (
              <>
                Next
                <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
