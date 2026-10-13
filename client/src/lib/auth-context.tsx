import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { User } from "@shared/schema";

interface SuspensionInfo {
  suspendedUntil: string;
  reason: string | null;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  suspensionInfo: SuspensionInfo | null;
  login: (demoId: string) => Promise<void>;
  logout: () => void;
  refetchUser: () => Promise<void>;
  clearSuspension: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [suspensionInfo, setSuspensionInfo] = useState<SuspensionInfo | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
      });
      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
        setSuspensionInfo(null);
      } else if (response.status === 403) {
        const data = await response.json();
        if (data.accountStatus === "suspended") {
          setSuspensionInfo({
            suspendedUntil: data.suspendedUntil,
            reason: data.reason || null,
          });
          setUser(null);
        } else if (data.accountStatus === "banned") {
          setSuspensionInfo(null);
          setUser(null);
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error("Auth check failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (demoId: string) => {
    try {
        const response = await fetch("/api/auth/dev-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ discordId }),
          credentials: "include",
        });
        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
          setSuspensionInfo(null);
          window.location.href = "/dashboard";
        } else if (response.status === 403) {
          const data = await response.json();
          if (data.accountStatus === "suspended") {
            setSuspensionInfo({
              suspendedUntil: data.suspendedUntil,
              reason: data.reason || null,
            });
            setUser(null);
          }
        }
      } catch (error) {
        console.error("Login failed:", error);
      }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      setUser(null);
      setSuspensionInfo(null);
      window.location.href = "/";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const clearSuspension = () => {
    setSuspensionInfo(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, suspensionInfo, login, logout, refetchUser: checkAuth, clearSuspension }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
