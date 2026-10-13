import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Briefcase, Wallet, Star, Shield, Clock, Users, Bell } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

interface TutorialSlide {
  title: string;
  description: string;
  icon: typeof Briefcase;
  tips: string[];
}

const freelancerSlides: TutorialSlide[] = [
  {
    title: "Welcome to Linxova",
    description: "Your professional freelance marketplace. Let's get you started with the key features.",
    icon: Star,
    tips: [
      "Complete your profile to attract more clients",
      "Set your specialization to stand out",
      "Configure working hours for better scheduling"
    ]
  },
  {
    title: "Finding Jobs",
    description: "Browse available jobs and claim the ones that match your skills.",
    icon: Briefcase,
    tips: [
      "Use the search bar to find specific job types",
      "Filter by budget range to find well-paying gigs",
      "Check job deadlines before claiming"
    ]
  },
  {
    title: "Managing Your Work",
    description: "Track your current job and collaborate with team members.",
    icon: Users,
    tips: [
      "You can only work on one job at a time",
      "Invite team members for larger projects",
      "Use team chat for real-time communication"
    ]
  },
  {
    title: "Getting Paid",
    description: "Receive payments for completed work.",
    icon: Wallet,
    tips: [
      "Payments are held until job completion",
      "Track your earnings in real-time",
      "Withdraw funds when you're ready"
    ]
  },
  {
    title: "Time Management",
    description: "Set your availability and request time off when needed.",
    icon: Clock,
    tips: [
      "Configure working hours from your profile",
      "Request PTO up to 3 weeks in advance",
      "All times displayed in Eastern Time (ET)"
    ]
  },
  {
    title: "Growing Your Career",
    description: "Level up by completing jobs and earning great ratings.",
    icon: Star,
    tips: [
      "Complete 5 jobs to reach Level 2",
      "Higher levels unlock more opportunities",
      "Apply to become a Moderator at level 5 "
    ]
  }
];

const customerSlides: TutorialSlide[] = [
  {
    title: "Welcome to Linxova",
    description: "Post jobs and find talented freelancers for your projects.",
    icon: Star,
    tips: [
      "Create detailed job descriptions for better matches",
      "Set realistic budgets and deadlines",
      "Review freelancer profiles before hiring"
    ]
  },
  {
    title: "Posting Jobs",
    description: "Create job listings to attract qualified freelancers.",
    icon: Briefcase,
    tips: [
      "Be specific about requirements",
      "Jobs require moderator approval before posting",
      "Respond to 'Changes Requested' feedback promptly"
    ]
  },
  {
    title: "Managing Projects",
    description: "Track your job progress and communicate with freelancers.",
    icon: Users,
    tips: [
      "Use the team chat for project updates",
      "View My Jobs page for all your listings",
      "Rate freelancers after job completion"
    ]
  },
  {
    title: "Payments",
    description: "Fund your wallet and pay for completed work.",
    icon: Wallet,
    tips: [
      "Deposit funds to your wallet",
      "Payments are held securely until completion",
      "Track all transactions in your wallet"
    ]
  },
  {
    title: "Becoming a Freelancer",
    description: "Ready to offer your own services? Apply to become a freelancer.",
    icon: Star,
    tips: [
      "Use Role Upgrade to apply",
      "Share your experience and portfolio",
      "Moderators will review your application"
    ]
  }
];

const moderatorSlides: TutorialSlide[] = [
  {
    title: "Welcome Moderator",
    description: "You play a crucial role in maintaining platform quality.",
    icon: Shield,
    tips: [
      "Review job listings for quality and compliance",
      "Ensure fair and accurate job descriptions",
      "Help maintain community standards"
    ]
  },
  {
    title: "Moderation Queue",
    description: "Review and approve job listings from customers.",
    icon: Briefcase,
    tips: [
      "Approve well-written, legitimate jobs",
      "Request changes for incomplete listings",
      "Reject inappropriate or fraudulent posts"
    ]
  },
  {
    title: "Role Upgrade Reviews",
    description: "Review applications from users wanting to upgrade their roles.",
    icon: Users,
    tips: [
      "Review customer-to-freelancer applications",
      "Review freelancer-to-moderator applications",
      "Check qualifications and experience"
    ]
  },
  {
    title: "Notifications",
    description: "Stay updated on platform activities.",
    icon: Bell,
    tips: [
      "New job submissions need your attention",
      "Upgrade requests await your review",
      "System alerts for important updates"
    ]
  }
];

const headOfModerationSlides: TutorialSlide[] = [
  {
    title: "Welcome Head of Moderation",
    description: "As Head of Moderation, you lead the moderation team and ensure platform quality.",
    icon: Shield,
    tips: [
      "Oversee all moderation activities",
      "Manage and support your moderator team",
      "Set standards for content quality"
    ]
  },
  {
    title: "Team Management",
    description: "Coordinate your moderation team effectively.",
    icon: Users,
    tips: [
      "Assign tasks to moderators",
      "Schedule team meetings and check-ins",
      "Monitor team performance and workload"
    ]
  },
  {
    title: "Meeting Scheduling",
    description: "Organize meetings with your moderation team.",
    icon: Clock,
    tips: [
      "Schedule individual or team-wide meetings",
      "Track RSVP responses from moderators",
      "All times displayed in Eastern Time (ET)"
    ]
  },
  {
    title: "Team Room",
    description: "Collaborate in real-time with your moderation team.",
    icon: Users,
    tips: [
      "Use team chat for quick discussions",
      "Join voice calls for important conversations",
      "Stay connected with your team"
    ]
  },
  {
    title: "Moderation Vault",
    description: "Manage team compensation from the moderation vault.",
    icon: Wallet,
    tips: [
      "View available funds from Founder deposits",
      "Distribute payments to moderators",
      "Track all vault transactions"
    ]
  },
  {
    title: "Reports & Reviews",
    description: "Handle user reports and upgrade requests.",
    icon: Shield,
    tips: [
      "Review user reports promptly",
      "Process role upgrade applications",
      "Escalate serious issues when needed"
    ]
  }
];

interface TutorialModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TutorialModal({ open, onOpenChange }: TutorialModalProps) {
  const { user } = useAuth();
  const [currentSlide, setCurrentSlide] = useState(0);

  const getSlides = (): TutorialSlide[] | null => {
    // Founder doesn't need onboarding tutorial
    if (user?.role === "founder") {
      return null;
    }
    if (user?.role === "head_of_moderation") {
      return headOfModerationSlides;
    }
    if (user?.role === "moderator" || user?.role === "staff") {
      return moderatorSlides;
    }
    if (user?.role === "customer") {
      return customerSlides;
    }
    return freelancerSlides;
  };

  const slides = getSlides();
  
  // If no slides (e.g., founder), close the modal immediately
  if (!slides) {
    if (open) {
      onOpenChange(false);
    }
    return null;
  }
  
  const slide = slides[currentSlide];
  const progress = ((currentSlide + 1) / slides.length) * 100;
  const isLastSlide = currentSlide === slides.length - 1;
  const isFirstSlide = currentSlide === 0;

  const handleNext = () => {
    if (isLastSlide) {
      onOpenChange(false);
      setCurrentSlide(0);
    } else {
      setCurrentSlide(prev => prev + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirstSlide) {
      setCurrentSlide(prev => prev - 1);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setCurrentSlide(0);
  };

  const Icon = slide.icon;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" data-testid="modal-tutorial">
        <DialogHeader>
          <Badge variant="secondary" className="mb-2 w-fit">
            {currentSlide + 1} of {slides.length}
          </Badge>
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-full bg-primary/10">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <DialogTitle className="text-xl">{slide.title}</DialogTitle>
          </div>
          <DialogDescription className="text-base pt-2">
            {slide.description}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <h4 className="text-sm font-medium mb-3 text-muted-foreground">Quick Tips:</h4>
          <ul className="space-y-2">
            {slide.tips.map((tip, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span className="text-primary mt-0.5">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>

        <Progress value={progress} className="h-1" data-testid="progress-tutorial" />

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={handlePrev}
            disabled={isFirstSlide}
            data-testid="button-prev-slide"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Previous
          </Button>
          <Button
            onClick={handleNext}
            data-testid="button-next-slide"
          >
            {isLastSlide ? (
              "Get Started"
            ) : (
              <>
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
