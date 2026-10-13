import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { Briefcase, Wallet, Shield, Users } from "lucide-react";
import logoLight from "@assets/logo-light.png";
import logoDark from "@assets/logo-dark.png";

export default function LoginPage() {
  const { login } = useAuth();

  const demoAccounts = [
    { id: "demo-freelancer-1", label: "Demo Freelancer", description: "Alex Chen - Web Developer" },
    { id: "demo-customer-1", label: "Demo Customer", description: "Tech Startup Inc" },
    { id: "demo-moderator-1", label: "Demo Moderator", description: "Admin User" },
    { id: "demo-head-mod-1", label: "Demo Head of Moderation", description: "Head Moderator" },
    { id: "demo-founder-1", label: "Demo Founder", description: "Founder - Full Access" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img 
              src={logoLight} 
              alt="Linxova" 
              className="w-12 h-12 dark:hidden"
            />
            <img 
              src={logoDark} 
              alt="Linxova" 
              className="w-12 h-12 hidden dark:block"
            />
            <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-primary to-purple-600 bg-clip-text text-transparent">
              Linxova
            </h1>
          </div>
          <p className="text-xl text-muted-foreground">
            Professional Freelancer Marketplace
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 items-start">
          <Card className="border-2">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">Welcome Back</CardTitle>
              <CardDescription>
                Sign in to access your account
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-muted-foreground text-center uppercase tracking-wide">
                Choose an account to continue
              </p>

              <div className="space-y-2">
                {demoAccounts.map((account) => (
                  <Button
                    key={account.id}
                    onClick={() => login(account.id)}
                    variant="outline"
                    className="w-full justify-start gap-3 h-auto py-3"
                    data-testid={`button-demo-${account.id}`}
                  >
                    <div className="flex flex-col items-start">
                      <div className="font-medium">{account.label}</div>
                      <div className="text-xs text-muted-foreground">{account.description}</div>
                    </div>
                  </Button>
                ))}
              </div>

              <p className="text-xs text-center text-muted-foreground">
                Demo accounts are for testing purposes only
              </p>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold mb-4">Platform Features</h3>
            <Card className="hover-elevate">
              <CardContent className="p-4 flex gap-4">
                <div className="bg-primary/10 p-3 rounded-lg">
                  <Briefcase className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Job Marketplace</h4>
                  <p className="text-sm text-muted-foreground">
                    Post jobs or find opportunities with smart matching
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="hover-elevate">
              <CardContent className="p-4 flex gap-4">
                <div className="bg-primary/10 p-3 rounded-lg">
                  <Wallet className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Crypto Wallet</h4>
                  <p className="text-sm text-muted-foreground">
                    Track and manage USDT, BTC, SOL, and LTC payments
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="hover-elevate">
              <CardContent className="p-4 flex gap-4">
                <div className="bg-primary/10 p-3 rounded-lg">
                  <Users className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Team Collaboration</h4>
                  <p className="text-sm text-muted-foreground">
                    Invite freelancers and work together on projects
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="hover-elevate">
              <CardContent className="p-4 flex gap-4">
                <div className="bg-primary/10 p-3 rounded-lg">
                  <Shield className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Secure & Moderated</h4>
                  <p className="text-sm text-muted-foreground">
                    All jobs reviewed before publication for quality
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
