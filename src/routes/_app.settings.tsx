import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/state";
import type { Broker, BrokerAccount, Profile, UserSettings } from "@/lib/types";
import { useAuth, useSupabase } from "@/providers/auth";
import { usePortfolios } from "@/providers/portfolio";

export const Route = createFileRoute("/_app/settings")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Settings — PortfolioAI" },
      {
        name: "description",
        content: "Manage your profile, display preferences, portfolios and broker accounts.",
      },
      { property: "og:title", content: "Settings — PortfolioAI" },
      {
        property: "og:description",
        content: "Manage your profile, display preferences, portfolios and broker accounts.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your profile, display preferences, portfolios and broker accounts."
      />
      <Tabs defaultValue="portfolios">
        <TabsList>
          <TabsTrigger value="portfolios">Portfolios</TabsTrigger>
          <TabsTrigger value="accounts">Broker accounts</TabsTrigger>
          <TabsTrigger value="profile">Profile &amp; preferences</TabsTrigger>
        </TabsList>
        <TabsContent value="portfolios" className="mt-4">
          <PortfoliosPanel />
        </TabsContent>
        <TabsContent value="accounts" className="mt-4">
          <BrokerAccountsPanel />
        </TabsContent>
        <TabsContent value="profile" className="mt-4">
          <ProfilePanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PortfoliosPanel() {
  const supabase = useSupabase();
  const { user } = useAuth();
  const { portfolios, isLoading, error, activePortfolio, setActivePortfolioId, refetch } =
    usePortfolios();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        owner_id: user!.id,
        name: name.trim(),
        base_currency: "INR",
      };
      const parsedTarget = target.trim() === "" ? null : Number(target);
      if (parsedTarget !== null) {
        if (!Number.isInteger(parsedTarget) || parsedTarget < 0) {
          throw new Error("Core target must be a whole number of stocks.");
        }
        payload.core_target_count = parsedTarget;
      }
      const { data, error: insertError } = await supabase
        .from("portfolios")
        .insert(payload)
        .select("id")
        .single();
      if (insertError) throw new Error(insertError.message);
      return data as { id: string };
    },
    onSuccess: async (data) => {
      setName("");
      setTarget("");
      await refetch();
      setActivePortfolioId(data.id);
      toast.success("Portfolio created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error: updateError } = await supabase
        .from("portfolios")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (updateError) throw new Error(updateError.message);
    },
    onSuccess: async () => {
      await refetch();
      toast.success("Portfolio archived");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Your portfolios"
        description="Core target is a number of stocks, not an allocation percentage."
      >
        {isLoading ? <LoadingState label="Loading portfolios" /> : null}
        {error ? <ErrorState error={error} /> : null}
        {portfolios.length === 0 && !isLoading ? (
          <p className="text-sm text-muted-foreground">No portfolio yet.</p>
        ) : null}
        <ul className="divide-y divide-border">
          {portfolios.map((portfolio) => (
            <li key={portfolio.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{portfolio.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {portfolio.base_currency} · core target{" "}
                  {portfolio.core_target_count ?? "not set"}
                </p>
              </div>
              {activePortfolio?.id === portfolio.id ? (
                <StatusBadge tone="ok">Active</StatusBadge>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setActivePortfolioId(portfolio.id)}>
                  Make active
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => archive.mutate(portfolio.id)}
                disabled={archive.isPending}
              >
                Archive
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Create a portfolio">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create.mutate();
          }}
        >
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="portfolio-name">Name</Label>
            <Input
              id="portfolio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Long-term equity"
              required
            />
          </div>
          <div className="w-40 space-y-1.5">
            <Label htmlFor="portfolio-target">Core target (stocks)</Label>
            <Input
              id="portfolio-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="35"
            />
          </div>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
      </Panel>
    </div>
  );
}

export function BrokerAccountsPanel({ compact = false }: { compact?: boolean }) {
  const supabase = useSupabase();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [brokerId, setBrokerId] = useState("");
  const [nickname, setNickname] = useState("");
  const [masked, setMasked] = useState("");

  const brokers = useQuery({
    queryKey: ["brokers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("brokers").select("*").order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Broker[];
    },
  });

  const accounts = useQuery({
    queryKey: ["broker-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("broker_accounts")
        .select("*")
        .order("created_at");
      if (error) throw new Error(error.message);
      return (data ?? []) as BrokerAccount[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!brokerId) throw new Error("Choose a broker.");
      if (!nickname.trim()) throw new Error("Give the account a name.");
      const payload: Record<string, unknown> = {
        owner_id: user!.id,
        broker_id: brokerId,
        nickname: nickname.trim(),
      };
      if (masked.trim()) payload.masked_account_reference = masked.trim();
      const { error } = await supabase.from("broker_accounts").insert(payload);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setNickname("");
      setMasked("");
      void queryClient.invalidateQueries({ queryKey: ["broker-accounts"] });
      toast.success("Broker account added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const brokerName = (id: string) => brokers.data?.find((b) => b.id === id)?.name ?? "Broker";

  return (
    <div className="space-y-4">
      {!compact ? (
        <Panel
          title="Broker accounts"
          description="Never store login credentials here. A masked reference is enough to tell accounts apart."
        >
          {accounts.isLoading ? <LoadingState label="Loading accounts" /> : null}
          {accounts.error ? <ErrorState error={accounts.error} /> : null}
          {accounts.data && accounts.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No broker account yet.</p>
          ) : null}
          <ul className="divide-y divide-border">
            {(accounts.data ?? []).map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{account.nickname}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {brokerName(account.broker_id)}
                    {account.masked_account_reference
                      ? ` · ${account.masked_account_reference}`
                      : ""}
                  </p>
                </div>
                {account.archived_at ? <StatusBadge tone="neutral">Archived</StatusBadge> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Add a broker account">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="w-52 space-y-1.5">
            <Label>Broker</Label>
            <Select value={brokerId} onValueChange={setBrokerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select broker" />
              </SelectTrigger>
              <SelectContent>
                {(brokers.data ?? []).map((broker) => (
                  <SelectItem key={broker.id} value={broker.id}>
                    {broker.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label htmlFor="account-nickname">Account name</Label>
            <Input
              id="account-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Primary demat"
            />
          </div>
          <div className="w-44 space-y-1.5">
            <Label htmlFor="account-masked">Masked reference</Label>
            <Input
              id="account-masked"
              value={masked}
              onChange={(e) => setMasked(e.target.value)}
              placeholder="****1234"
            />
          </div>
          <Button type="submit" disabled={create.isPending}>
            Add
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function ProfilePanel() {
  const supabase = useSupabase();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const [profile, settings] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user!.id).maybeSingle(),
        supabase.from("user_settings").select("*").eq("user_id", user!.id).maybeSingle(),
      ]);
      if (profile.error) throw new Error(profile.error.message);
      if (settings.error) throw new Error(settings.error.message);
      return {
        profile: profile.data as Profile | null,
        settings: settings.data as UserSettings | null,
      };
    },
  });

  const [displayName, setDisplayName] = useState("");
  const [dateFormat, setDateFormat] = useState("DD-MM-YYYY");
  const [timezone, setTimezone] = useState("Asia/Kolkata");

  useEffect(() => {
    if (!query.data) return;
    setDisplayName(query.data.profile?.display_name ?? "");
    setDateFormat(query.data.settings?.date_format ?? "DD-MM-YYYY");
    setTimezone(query.data.settings?.timezone ?? "Asia/Kolkata");
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => {
      const profileUpdate = await supabase
        .from("profiles")
        .update({ display_name: displayName.trim() || null })
        .eq("id", user!.id);
      if (profileUpdate.error) throw new Error(profileUpdate.error.message);
      const settingsUpdate = await supabase
        .from("user_settings")
        .update({ date_format: dateFormat, timezone: timezone.trim() })
        .eq("user_id", user!.id);
      if (settingsUpdate.error) throw new Error(settingsUpdate.error.message);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Preferences saved");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (query.isLoading) return <LoadingState label="Loading your profile" />;
  if (query.error) return <ErrorState error={query.error} />;

  return (
    <Panel title="Profile and display preferences">
      <form
        className="grid max-w-xl gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Date format</Label>
          <Select value={dateFormat} onValueChange={setDateFormat}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"].map((format) => (
                <SelectItem key={format} value={format}>
                  {format}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone">Time zone</Label>
          <Input id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          Signed in as {user?.email}
        </p>
        <div>
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}
