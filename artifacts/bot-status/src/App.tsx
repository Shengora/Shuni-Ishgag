import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Activity, Network, Clock, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

const queryClient = new QueryClient();

function StatusIndicator({ status }: { status: 'checking' | 'online' | 'offline' }) {
  const isOnline = status === 'online';
  const colorClass = isOnline
    ? 'bg-primary'
    : status === 'offline'
      ? 'bg-destructive'
      : 'bg-muted-foreground';

  return (
    <div className="relative flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 mb-8 sm:mb-10 group">
      {isOnline && (
        <>
          <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping opacity-75 duration-1000" />
          <div className="absolute inset-2 bg-primary/30 rounded-full animate-pulse duration-700" />
        </>
      )}
      <div className="relative z-10 flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 bg-card rounded-full border border-primary/50 shadow-[0_0_15px_rgba(0,255,209,0.5)]">
        <div className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full ${colorClass}`} />
      </div>
    </div>
  );
}

function StatRow({ icon: Icon, label, value, valueClass = "text-foreground" }: { icon: any, label: string, value: string, valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border/50 last:border-0 group hover:bg-muted/30 px-3 -mx-3 rounded-md transition-colors">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Icon className="w-4 h-4" />
        <span className="font-sans text-sm tracking-wide">{label}</span>
      </div>
      <div className={`font-mono text-sm tracking-tight ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function Home() {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const res = await fetch('/api/healthz');
        if (!cancelled) {
          setStatus(res.ok ? 'online' : 'offline');
          setCheckedAt(new Date());
        }
      } catch {
        if (!cancelled) {
          setStatus('offline');
          setCheckedAt(new Date());
        }
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const statusLabel =
    status === 'checking'
      ? 'CHECKING...'
      : status === 'online'
        ? 'BOT ONLINE'
        : 'BOT UNREACHABLE';

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background relative overflow-hidden selection:bg-primary/30">
      
      {/* Background radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      
      {/* Grid pattern overlay */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-[0.03]"
        style={{ 
          backgroundImage: 'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '40px 40px'
        }}
      />

      <div className="relative z-10 w-full max-w-md p-6 sm:p-8">
        <div className="flex flex-col items-center mb-8">
          <StatusIndicator status={status} />
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground font-sans tracking-tight mb-2">
            Massages Premium
          </h1>
          <div
            className={`flex items-center gap-2 font-mono text-sm px-3 py-1 rounded-full border ${
              status === 'online'
                ? 'text-primary bg-primary/10 border-primary/20'
                : status === 'offline'
                  ? 'text-destructive bg-destructive/10 border-destructive/20'
                  : 'text-muted-foreground bg-muted/20 border-border'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                status === 'checking' ? '' : 'animate-pulse'
              } ${
                status === 'online'
                  ? 'bg-primary'
                  : status === 'offline'
                    ? 'bg-destructive'
                    : 'bg-muted-foreground'
              }`}
            />
            {statusLabel}
          </div>
        </div>

        <div className="bg-card/80 backdrop-blur-md border border-border p-6 rounded-xl shadow-2xl">
          <div className="space-y-1 mb-6">
            <div className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase tracking-widest mb-4">
              <span>Service Status</span>
              <span>Live</span>
            </div>
          </div>

          <div className="flex flex-col">
            <StatRow
              icon={Activity}
              label="Bot Service"
              value={status === 'online' ? 'Reachable' : status === 'offline' ? 'Unreachable' : 'Checking...'}
              valueClass={status === 'online' ? 'text-primary' : status === 'offline' ? 'text-destructive' : 'text-muted-foreground'}
            />
            <StatRow icon={Network} label="Endpoint" value="/api/healthz" />
            <StatRow
              icon={Clock}
              label="Last Checked"
              value={checkedAt ? checkedAt.toLocaleTimeString() : '--'}
            />
          </div>
        </div>

        <div className="mt-8 flex justify-center items-center text-xs text-muted-foreground font-mono opacity-60">
          <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
          Secured by internal network
        </div>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
