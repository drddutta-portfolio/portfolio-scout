import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/providers/auth";
import type { Portfolio } from "@/lib/types";

const STORAGE_KEY = "portfolioai.active_portfolio_id";

interface PortfolioContextValue {
  portfolios: Portfolio[];
  activePortfolio: Portfolio | null;
  activePortfolioId: string | null;
  setActivePortfolioId: (id: string) => void;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const { client, user } = useAuth();
  const [storedId, setStoredId] = useState<string | null>(null);

  useEffect(() => {
    try {
      setStoredId(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      setStoredId(null);
    }
  }, []);

  const query = useQuery({
    queryKey: ["portfolios", user?.id],
    enabled: Boolean(client && user),
    queryFn: async (): Promise<Portfolio[]> => {
      const { data, error } = await client!
        .from("portfolios")
        .select("*")
        .is("archived_at", null)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Portfolio[];
    },
  });

  const portfolios = useMemo(() => query.data ?? [], [query.data]);

  // Only a validated, owned portfolio id is ever active.
  const activePortfolio = useMemo(() => {
    if (portfolios.length === 0) return null;
    return portfolios.find((p) => p.id === storedId) ?? portfolios[0] ?? null;
  }, [portfolios, storedId]);

  const setActivePortfolioId = useCallback((id: string) => {
    setStoredId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable: in-memory selection still works */
    }
  }, []);

  const value = useMemo<PortfolioContextValue>(
    () => ({
      portfolios,
      activePortfolio,
      activePortfolioId: activePortfolio?.id ?? null,
      setActivePortfolioId,
      isLoading: query.isLoading,
      error: (query.error as Error) ?? null,
      refetch: () => void query.refetch(),
    }),
    [portfolios, activePortfolio, setActivePortfolioId, query],
  );

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolios() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolios must be used inside PortfolioProvider");
  return ctx;
}
